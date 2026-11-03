import { Inject, Injectable } from "@nestjs/common";
import { addHours } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService, toNum } from "../prisma/prisma.service.js";
import {
  applyMarketContext,
  buildMarketContext,
  computeBaseFeatures,
  type FeatureVector,
  type MarketContext,
  type SeriesPoint,
} from "./compute.js";
import { countReasons, eligibilityExclusions, EXCLUDED_CLASSES, inScreenUniverse } from "../screening/universe.js";
import { FEATURE_SET_VERSION, FEATURES, STATISTICAL_WARMUP_SNAPSHOTS } from "./registry.js";

export interface AssetFeatures {
  assetId: string;
  features: FeatureVector;
  series: SeriesPoint[];
}

/** How the coins observed in a slot split between the screen universe and permanent exclusions. */
export interface UniverseSummary {
  /** Coins with a snapshot in this slot (every collected coin). */
  observed: number;
  /** Coins the screen evaluates (features + screening rows). */
  evaluated: number;
  /** Coins that can never be eligible at this slot (class or market-cap floor). */
  outside: number;
  /** Exclusion reasons of the outside coins (a coin can carry several). */
  outsideReasons: Record<string, number>;
}

export interface FeatureRunResult {
  slot: Date;
  market: MarketContext;
  perAsset: Map<string, AssetFeatures>;
  universe: UniverseSummary;
}

const ID_CHUNK = 2000;

@Injectable()
export class FeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async ensureDefinitions() {
    await this.prisma.featureSetVersion.upsert({
      where: { version: FEATURE_SET_VERSION },
      create: { version: FEATURE_SET_VERSION, definitions: FEATURES as never },
      update: {},
    });
  }

  /**
   * Point-in-time feature computation for `slot`: only snapshots with slotTime <= slot are read,
   * so the same code is safe for backtesting without look-ahead.
   */
  async computeForSlot(providerId: string, slot: Date, opts: { persist: boolean } = { persist: true }): Promise<FeatureRunResult> {
    const lookbackHours = STATISTICAL_WARMUP_SNAPSHOTS + 1;
    const floors = { minMarketCapUsd: this.cfg.MIN_MARKET_CAP_USD, minVolume24hUsd: this.cfg.MIN_VOLUME_24H_USD };

    // One row per collected coin decides who the strategy evaluates; only those need history.
    const current = await this.prisma.marketSnapshot.findMany({
      where: { providerId, slotTime: slot },
      select: { assetId: true, price: true, marketCap: true, volumeRolling24h: true, isStale: true, asset: { select: { id: true, assetClass: true, isBenchmark: true, symbol: true } } },
    });
    const inside: string[] = [];
    const outsideReasons: string[][] = [];
    for (const c of current) {
      const latest = { price: toNum(c.price), marketCap: toNum(c.marketCap), volumeRolling24h: toNum(c.volumeRolling24h), isStale: c.isStale };
      if (inScreenUniverse(c.asset, latest, floors)) inside.push(c.assetId);
      else outsideReasons.push(eligibilityExclusions(c.asset, latest, floors));
    }
    const universe: UniverseSummary = { observed: current.length, evaluated: inside.length, outside: outsideReasons.length, outsideReasons: countReasons(outsideReasons) };

    const select = {
      assetId: true,
      slotTime: true,
      price: true,
      marketCap: true,
      volumeRolling24h: true,
      isStale: true,
      providerChangePct1h: true,
      providerChangePct24h: true,
      bidAskSpreadPct: true,
      depthPlus2PctUsd: true,
    } as const;
    const rows = [];
    for (let i = 0; i < inside.length; i += ID_CHUNK) {
      rows.push(
        ...(await this.prisma.marketSnapshot.findMany({
          where: { providerId, assetId: { in: inside.slice(i, i + ID_CHUNK) }, slotTime: { gte: addHours(slot, -lookbackHours), lte: slot } },
          select,
          orderBy: [{ assetId: "asc" }, { slotTime: "asc" }],
        })),
      );
    }
    const byAsset = new Map<string, SeriesPoint[]>();
    for (const r of rows) {
      const list = byAsset.get(r.assetId) ?? [];
      list.push({
        slotTime: r.slotTime,
        price: toNum(r.price),
        marketCap: toNum(r.marketCap),
        volumeRolling24h: toNum(r.volumeRolling24h),
        isStale: r.isStale,
        providerChangePct1h: toNum(r.providerChangePct1h),
        providerChangePct24h: toNum(r.providerChangePct24h),
        bidAskSpreadPct: toNum(r.bidAskSpreadPct),
        depthPlus2PctUsd: toNum(r.depthPlus2PctUsd),
      });
      byAsset.set(r.assetId, list);
    }
    // Only assets observed in this slot get features for it.
    for (const [id, s] of byAsset) if (s[s.length - 1]!.slotTime.getTime() !== slot.getTime()) byAsset.delete(id);

    const assets = current.map((c) => c.asset).filter((a) => byAsset.has(a.id));
    const meta = new Map(assets.map((a) => [a.id, a]));
    const opts2 = { snapshotWindow: this.cfg.SNAPSHOT_WINDOW, statisticalWarmup: STATISTICAL_WARMUP_SNAPSHOTS, paperNotionalUsd: 1_000 };

    const base = new Map<string, FeatureVector>();
    for (const [id, s] of byAsset) base.set(id, computeBaseFeatures(s, opts2));

    const benchFor = (sym: string) => {
      const a = assets.find((x) => x.isBenchmark && x.symbol === sym);
      return a ? (base.get(a.id) ?? null) : null;
    };
    const marketPopulation = [...base.entries()]
      .filter(([id]) => {
        const m = meta.get(id);
        const last = byAsset.get(id)!.at(-1)!;
        return m && !EXCLUDED_CLASSES.has(m.assetClass) && !last.isStale && (last.marketCap ?? 0) >= this.cfg.MIN_MARKET_CAP_USD;
      })
      .map(([, f]) => f);
    const market = buildMarketContext({ btc: benchFor("BTC"), eth: benchFor("ETH"), universe: marketPopulation });

    const perAsset = new Map<string, AssetFeatures>();
    for (const [id, f] of base) perAsset.set(id, { assetId: id, features: applyMarketContext(f, market), series: byAsset.get(id)! });

    if (opts.persist) {
      const data = [...perAsset.values()].map((a) => ({
        assetId: a.assetId,
        providerId,
        slotTime: slot,
        featureSetVersion: FEATURE_SET_VERSION,
        values: a.features.values,
        unavailable: a.features.unavailable,
        historyDepth: a.features.historyDepth,
        warmupState: a.features.warmupState,
      }));
      for (let i = 0; i < data.length; i += 1000) await this.prisma.featureValue.createMany({ data: data.slice(i, i + 1000), skipDuplicates: true });
    }
    return { slot, market, perAsset, universe };
  }
}

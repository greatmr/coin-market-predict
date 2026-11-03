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
import { FEATURE_SET_VERSION, FEATURES, STATISTICAL_WARMUP_SNAPSHOTS } from "./registry.js";

export interface AssetFeatures {
  assetId: string;
  features: FeatureVector;
  series: SeriesPoint[];
}

export interface FeatureRunResult {
  slot: Date;
  market: MarketContext;
  perAsset: Map<string, AssetFeatures>;
}

const EXCLUDED_FROM_MARKET = new Set(["stablecoin", "wrapped", "bridged", "staked"]);

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
    const rows = await this.prisma.marketSnapshot.findMany({
      where: { providerId, slotTime: { gte: addHours(slot, -lookbackHours), lte: slot } },
      select: {
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
      },
      orderBy: [{ assetId: "asc" }, { slotTime: "asc" }],
    });
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

    const assets = await this.prisma.asset.findMany({
      where: { id: { in: [...byAsset.keys()] } },
      select: { id: true, assetClass: true, isBenchmark: true, symbol: true },
    });
    const meta = new Map(assets.map((a) => [a.id, a]));
    const opts2 = { snapshotWindow: this.cfg.SNAPSHOT_WINDOW, statisticalWarmup: STATISTICAL_WARMUP_SNAPSHOTS, paperNotionalUsd: 1_000 };

    const base = new Map<string, FeatureVector>();
    for (const [id, s] of byAsset) base.set(id, computeBaseFeatures(s, opts2));

    const benchFor = (sym: string) => {
      const a = assets.find((x) => x.isBenchmark && x.symbol === sym);
      return a ? (base.get(a.id) ?? null) : null;
    };
    const universe = [...base.entries()]
      .filter(([id]) => {
        const m = meta.get(id);
        const last = byAsset.get(id)!.at(-1)!;
        return m && !EXCLUDED_FROM_MARKET.has(m.assetClass) && !last.isStale && (last.marketCap ?? 0) >= this.cfg.MIN_MARKET_CAP_USD;
      })
      .map(([, f]) => f);
    const market = buildMarketContext({ btc: benchFor("BTC"), eth: benchFor("ETH"), universe });

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
    return { slot, market, perAsset };
  }
}

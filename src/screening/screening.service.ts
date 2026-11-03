import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import type { FeatureRunResult } from "../features/features.service.js";
import { FEATURE_SET_VERSION } from "../features/registry.js";
import { PrismaService, toNum } from "../prisma/prisma.service.js";
import type { EvidencePack } from "./evidence.js";
import { addHours } from "../common/time.js";
import { CMC_PROVIDERS, cmcIdsFor, latestBaselines } from "../read-model/vmc-lookup.js";
import { threeDayStats, vmcContext } from "./context.js";
import { buildScenario } from "./scenario.js";
import { rankAndShortlist, screenAsset, type ScreenInput, type ScreenOutput } from "./screen.js";
import { defaultStrategy, type StrategyParams } from "./strategy.js";

export type RankedOutput = ScreenOutput & { rank: number | null; shortlisted: boolean };

@Injectable()
export class ScreeningService {
  readonly strategy: StrategyParams;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.strategy = defaultStrategy({ minVolume24hUsd: cfg.MIN_VOLUME_24H_USD, minMarketCapUsd: cfg.MIN_MARKET_CAP_USD });
  }

  async ensureStrategy() {
    const s = this.strategy;
    await this.prisma.strategyVersion.upsert({
      where: { version: s.version },
      create: { version: s.version, description: s.description, params: s as never, researchTarget: s.target as never, featureSetVersion: FEATURE_SET_VERSION },
      update: {},
    });
  }

  /** Screen every asset that has features for the slot. Deterministic; no model calls. */
  async screen(runId: string | null, providerId: string, fr: FeatureRunResult, persist = true) {
    const ids = [...fr.perAsset.keys()];
    const [assets, latest] = await Promise.all([
      this.prisma.asset.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, symbol: true, assetClass: true, isBenchmark: true } }),
      this.prisma.marketSnapshot.findMany({ where: { providerId, slotTime: fr.slot, assetId: { in: ids } } }),
    ]);
    const latestBy = new Map(latest.map((s) => [s.assetId, s]));
    const outputs: ScreenOutput[] = assets.map((a) => {
      const s = latestBy.get(a.id);
      const input: ScreenInput = {
        assetId: a.id,
        name: a.name,
        symbol: a.symbol,
        assetClass: a.assetClass,
        isBenchmark: a.isBenchmark,
        hasCurrentSnapshot: !!s,
        latest: s
          ? {
              price: toNum(s.price),
              marketCap: toNum(s.marketCap),
              fullyDilutedValuation: toNum(s.fullyDilutedValuation),
              volumeRolling24h: toNum(s.volumeRolling24h),
              isStale: s.isStale,
              completeness: toNum(s.completeness) ?? 0,
              marketCapProvenance: s.marketCapProvenance,
              qualityFlags: s.qualityFlags,
            }
          : null,
        features: fr.perAsset.get(a.id)!.features,
      };
      return screenAsset(input, fr.market, this.strategy);
    });
    const ranked = rankAndShortlist(outputs, this.cfg.SHORTLIST_SIZE, this.strategy.minShortlistScore);

    if (persist && runId) {
      await this.prisma.screeningResult.createMany({
        data: ranked.map((r) => ({
          runId,
          assetId: r.assetId,
          slotTime: fr.slot,
          strategyVersion: this.strategy.version,
          eligible: r.eligible,
          exclusionReasons: r.exclusionReasons,
          classification: r.classification,
          heuristicScore: r.heuristicScore,
          components: r.components,
          riskFlags: r.riskFlags,
          rank: r.rank,
          shortlisted: r.shortlisted,
          pumpChance: r.pumpChance,
          pumpReasons: r.pumpReasons,
        })),
        skipDuplicates: true,
      });
    }
    return ranked;
  }

  async buildEvidence(providerId: string, fr: FeatureRunResult, shortlisted: RankedOutput[]): Promise<EvidencePack[]> {
    if (shortlisted.length === 0) return [];
    const ids = shortlisted.map((s) => s.assetId);
    const cmcIds = CMC_PROVIDERS.has(providerId) ? await this.cmcIds(providerId, ids) : new Map<string, number>();
    const [assets, provider, snaps, window72, baselines] = await Promise.all([
      this.prisma.asset.findMany({
        where: { id: { in: ids } },
        include: { contracts: true, identities: { where: { providerId } } },
      }),
      this.prisma.provider.findUniqueOrThrow({ where: { id: providerId } }),
      this.prisma.marketSnapshot.findMany({
        where: { providerId, assetId: { in: ids }, slotTime: { lte: fr.slot } },
        orderBy: { slotTime: "desc" },
        take: ids.length * Math.max(this.cfg.SNAPSHOT_WINDOW, 3) * 2,
      }),
      this.prisma.marketSnapshot.findMany({ where: { providerId, assetId: { in: ids }, slotTime: { gte: addHours(fr.slot, -72), lte: fr.slot } }, select: { assetId: true, slotTime: true, price: true } }),
      this.latestBaselines([...cmcIds.values()]),
    ]);
    return shortlisted.map((s) => {
      const a = assets.find((x) => x.id === s.assetId)!;
      const mine = snaps.filter((x) => x.assetId === s.assetId).slice(0, Math.max(this.cfg.SNAPSHOT_WINDOW, 3));
      const cur = mine[0]!;
      const f = fr.perAsset.get(s.assetId)!.features;
      const price = toNum(cur.price)!;
      return {
        assetId: s.assetId,
        identity: {
          name: a.name,
          symbol: a.symbol,
          provider: providerId,
          providerAssetId: a.identities[0]?.providerAssetId ?? cur.providerAssetId,
          contracts: a.contracts.map((c) => ({ chain: c.chain, contractAddress: c.contractAddress })),
          assetClass: a.assetClass,
        },
        source: { url: cur.sourceUrl, provider: providerId, isLive: provider.isLive, attribution: provider.attribution },
        latest: {
          slotTime: cur.slotTime.toISOString(),
          observedAt: cur.observedAt?.toISOString() ?? null,
          collectedAt: cur.collectedAt.toISOString(),
          freshnessSeconds: cur.freshnessSeconds,
          priceUsd: price,
          marketCapUsd: toNum(cur.marketCap),
          marketCapProvenance: cur.marketCapProvenance,
          volume24hUsd: toNum(cur.volumeRolling24h),
          volumeWindow: "rolling_24h",
          hourlyVolumeUsd: toNum(cur.volumeHourly),
          circulatingSupply: toNum(cur.circulatingSupply),
          qualityFlags: cur.qualityFlags,
          completeness: toNum(cur.completeness) ?? 0,
          nullReasons: cur.nullReasons as Record<string, string>,
        },
        recentSnapshots: mine.map((m) => ({
          slotTime: m.slotTime.toISOString(),
          observedAt: m.observedAt?.toISOString() ?? null,
          priceUsd: toNum(m.price),
          volume24hUsd: toNum(m.volumeRolling24h),
          isStale: m.isStale,
        })),
        features: f.values,
        unavailableFeatures: f.unavailable,
        historyDepth: f.historyDepth,
        warmupState: f.warmupState,
        screening: { classification: s.classification, heuristicScore: s.heuristicScore, components: s.components, riskFlags: s.riskFlags, rank: s.rank },
        market: fr.market,
        scenario: buildScenario({
          referencePrice: price,
          slotTime: fr.slot,
          classification: s.classification,
          params: this.strategy,
          feeBps: this.cfg.PAPER_FEE_BPS,
          slippageBps: this.cfg.PAPER_SLIPPAGE_BPS,
          estSlippagePct: f.values.est_slippage_pct ?? null,
        }),
        pump: { chance: s.pumpChance, reasons: s.pumpReasons },
        context: {
          threeDay: threeDayStats(window72.filter((w) => w.assetId === s.assetId).map((w) => ({ slotTime: w.slotTime, price: toNum(w.price) })), fr.slot),
          vmc: cmcIds.has(s.assetId) ? vmcContext(f.values.vol_mcap ?? null, baselines.get(cmcIds.get(s.assetId)!) ?? null) : null,
        },
        strategyVersion: this.strategy.version,
        featureSetVersion: FEATURE_SET_VERSION,
      } satisfies EvidencePack;
    });
  }

  /** CoinMarketCap numeric id per canonical asset (provider ids of CMC-based sources). */
  cmcIds(providerId: string, assetIds: string[]): Promise<Map<string, number>> {
    return cmcIdsFor(this.prisma, providerId, assetIds);
  }

  latestBaselines(cmcIds: number[]) {
    return latestBaselines(this.prisma, cmcIds);
  }
}

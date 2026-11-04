import { Inject, Injectable } from "@nestjs/common";
import { addHours } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { FEATURE_SET_VERSION } from "../features/registry.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService, toNum } from "../prisma/prisma.service.js";
import { threeDayStats, vmcContext } from "../screening/context.js";
import { byPumpChance, combineRecommendation, type PumpChance } from "../screening/recommend.js";
import { eligibilityExclusions, EXCLUDED_CLASSES, inScreenUniverse } from "../screening/universe.js";
import { plain } from "./plain.js";
import { cmcIdsFor, latestBaselines } from "./vmc-lookup.js";

/** Strategy features shown next to each screened coin (formatted by the dashboard). */
const KEY_FEATURES = ["ret_1h", "ret_2h", "accel_1h", "vol24_change_2h", "rs_market_2h", "rs_btc_1h", "vol_mcap", "provider_change_24h", "trend_persistence_12h", "breakout_24h", "ret_zscore_1h", "vol24_zscore_72h"] as const;

const STAGE_LABELS: Record<string, string> = {
  discover: "Discovering the coin listing",
  collect: "Collecting hourly snapshots for every listed coin",
  history: "Fetching genuine hourly history for coins that cannot be screened yet",
  features: "Calculating strategy features",
  screen: "Screening the strategy universe",
  analyze: "Agents are reviewing the shortlist",
  publish: "Publishing signals and updating paper trades",
  notify: "Preparing the Telegram report",
};

export type MarketSort = "market_cap" | "volume" | "change_1h" | "change_24h" | "change_7d" | "symbol";

/**
 * Read-only queries shared by the dashboard API, the MCP server, and agent tools.
 * PostgreSQL is the source of truth; nothing here writes.
 */
@Injectable()
export class ReadModelService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  private get floors() {
    return { minMarketCapUsd: this.cfg.MIN_MARKET_CAP_USD, minVolume24hUsd: this.cfg.MIN_VOLUME_24H_USD };
  }

  async listAssets(q: { search?: string; assetClass?: string; limit: number; offset: number }) {
    const where = {
      ...(q.assetClass ? { assetClass: q.assetClass } : {}),
      ...(q.search
        ? { OR: [{ symbol: { contains: q.search.toUpperCase() } }, { name: { contains: q.search, mode: "insensitive" as const } }] }
        : {}),
      identities: { some: { providerId: this.providerId } },
    };
    const [total, rows] = await Promise.all([
      this.prisma.asset.count({ where }),
      this.prisma.asset.findMany({
        where,
        orderBy: [{ symbol: "asc" }, { id: "asc" }],
        take: q.limit,
        skip: q.offset,
        include: { identities: { select: { providerId: true, providerAssetId: true, sourceUrl: true, delistedAt: true } }, contracts: { select: { chain: true, contractAddress: true } } },
      }),
    ]);
    return plain<Record<string, unknown>>({ total, offset: q.offset, assets: rows });
  }

  async coverage() {
    const providerId = this.providerId;
    const [provider, lastRun, lastDiscovery, health, assetCount, activeIdentities] = await Promise.all([
      this.prisma.provider.findUnique({ where: { id: providerId } }),
      this.prisma.pipelineRun.findFirst({ where: { providerId }, orderBy: { slotTime: "desc" } }),
      this.prisma.discoveryRun.findFirst({ where: { providerId }, orderBy: { startedAt: "desc" } }),
      this.prisma.sourceHealth.findUnique({ where: { providerId } }),
      this.prisma.asset.count({ where: { identities: { some: { providerId } } } }),
      this.prisma.assetIdentity.count({ where: { providerId, delistedAt: null } }),
    ]);
    const budget = providerId === "coinmarketcap_web" ? this.cfg.CMC_WEB_MONTHLY_REQUEST_BUDGET : providerId === "fixture" ? null : this.cfg.SOURCE_MONTHLY_REQUEST_BUDGET;
    return plain<Record<string, unknown>>({
      provider,
      isLiveData: provider?.isLive ?? false,
      knownAssets: assetCount,
      activeIdentities,
      lastDiscovery,
      lastRunSlot: lastRun?.slotTime ?? null,
      lastRunCoverage: lastRun?.coverage ?? null,
      sourceHealth: health,
      monthlyRequestBudget: budget,
    });
  }

  async snapshots(assetId: string, hours: number) {
    const latest = await this.prisma.marketSnapshot.findFirst({ where: { assetId, providerId: this.providerId }, orderBy: { slotTime: "desc" }, select: { slotTime: true } });
    if (!latest) return plain<Record<string, unknown>>({ assetId, snapshots: [] });
    const rows = await this.prisma.marketSnapshot.findMany({
      where: { assetId, providerId: this.providerId, slotTime: { gt: addHours(latest.slotTime, -hours) } },
      orderBy: { slotTime: "asc" },
    });
    return plain<Record<string, unknown>>({ assetId, snapshots: rows });
  }

  async features(assetId: string, limit: number) {
    const rows = await this.prisma.featureValue.findMany({ where: { assetId, providerId: this.providerId }, orderBy: { slotTime: "desc" }, take: limit });
    return plain<Record<string, unknown>>({ assetId, features: rows });
  }

  async assetDetail(assetId: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId }, include: { identities: true, contracts: true } });
    if (!asset) return null;
    const [screening, signal] = await Promise.all([
      this.prisma.screeningResult.findFirst({ where: { assetId, run: { providerId: this.providerId } }, orderBy: { slotTime: "desc" } }),
      this.prisma.signal.findFirst({ where: { assetId, run: { providerId: this.providerId } }, orderBy: { slotTime: "desc" }, include: { paperPosition: true } }),
    ]);
    return plain<Record<string, unknown>>({ ...asset, latestScreening: screening, latestSignal: signal });
  }

  /** Latest snapshot + key features for a set of assets at one slot, keyed by asset id. */
  private async quotesAndFeatures(assetIds: string[], slotTime: Date) {
    if (!assetIds.length) return { quotes: new Map(), features: new Map() };
    const [snaps, feats] = await Promise.all([
      this.prisma.marketSnapshot.findMany({
        where: { providerId: this.providerId, slotTime, assetId: { in: assetIds } },
        select: { assetId: true, price: true, marketCap: true, volumeRolling24h: true, providerChangePct1h: true, providerChangePct24h: true, providerChangePct7d: true, observedAt: true, isStale: true, sourceUrl: true, qualityFlags: true },
      }),
      this.prisma.featureValue.findMany({
        where: { providerId: this.providerId, slotTime, featureSetVersion: FEATURE_SET_VERSION, assetId: { in: assetIds } },
        select: { assetId: true, values: true, historyDepth: true, warmupState: true },
      }),
    ]);
    const quotes = new Map(
      snaps.map((s) => [
        s.assetId,
        {
          price: toNum(s.price),
          marketCap: toNum(s.marketCap),
          volume24h: toNum(s.volumeRolling24h),
          change1h: toNum(s.providerChangePct1h),
          change24h: toNum(s.providerChangePct24h),
          change7d: toNum(s.providerChangePct7d),
          observedAt: s.observedAt,
          isStale: s.isStale,
          sourceUrl: s.sourceUrl,
          qualityFlags: s.qualityFlags,
        },
      ]),
    );
    const features = new Map(
      feats.map((f) => {
        const v = (f.values ?? {}) as Record<string, number | null>;
        return [f.assetId, { values: Object.fromEntries(KEY_FEATURES.map((k) => [k, v[k] ?? null])), historyDepth: f.historyDepth, warmupState: f.warmupState }];
      }),
    );
    return { quotes, features };
  }

  async signals(q: { status?: string[]; classification?: string; runId?: string; limit: number }) {
    const runId = q.runId ?? (await this.latestRunId());
    const readiness = await this.predictionStatus();
    if (!runId) return plain<Record<string, unknown>>({ runId: null, signals: [], readiness });
    const rows = await this.prisma.signal.findMany({
      where: { runId, ...(q.status?.length ? { status: { in: q.status } } : {}) },
      include: { asset: { select: { name: true, symbol: true, assetClass: true } }, paperPosition: true },
      orderBy: { heuristicScore: "desc" },
      take: q.limit,
    });
    const screening = await this.prisma.screeningResult.findMany({ where: { runId, assetId: { in: rows.map((r) => r.assetId) } }, select: { assetId: true, classification: true, rank: true } });
    const cls = new Map(screening.map((s) => [s.assetId, s]));
    const slot = rows[0]?.slotTime;
    const extra = slot ? await this.quotesAndFeatures(rows.map((r) => r.assetId), slot) : { quotes: new Map(), features: new Map() };
    const merged = rows
      .map((r) => ({
        ...r,
        classification: cls.get(r.assetId)?.classification ?? null,
        rank: cls.get(r.assetId)?.rank ?? null,
        quote: extra.quotes.get(r.assetId) ?? null,
        keyFeatures: extra.features.get(r.assetId) ?? null,
      }))
      .filter((r) => !q.classification || r.classification === q.classification);
    return plain<Record<string, unknown>>({ runId, signals: merged, readiness });
  }

  /** Explain an empty prediction panel using persisted run and screening state. */
  async predictionStatus() {
    const latest = await this.prisma.pipelineRun.findFirst({ where: { providerId: this.providerId }, orderBy: [{ slotTime: "desc" }, { startedAt: "desc" }], include: { stages: true } });
    const common = { requiredSnapshots: this.cfg.SNAPSHOT_WINDOW, candidateMinHistory: this.cfg.CANDIDATE_MIN_HISTORY, agentProvider: this.cfg.AGENT_PROVIDER, runId: latest?.id ?? null, slotTime: latest?.slotTime ?? null };
    if (!latest) return { ...common, state: "waiting", message: this.cfg.SCHEDULER_ENABLED ? "Waiting for the first collection run to start." : "Automatic collection is disabled. Run the pipeline to collect and analyze market data." };
    const m = (latest.metrics ?? {}) as Record<string, unknown>;
    if (latest.status === "running") {
      const h = m.history as { attempted?: number; needed?: number } | undefined;
      const progress = latest.currentStage === "history" && h?.needed ? ` ${h.attempted ?? 0} of ${h.needed} coins done.` : "";
      return { ...common, state: "running", stage: latest.currentStage, startedAt: latest.startedAt, history: m.history ?? null, message: `${STAGE_LABELS[latest.currentStage ?? ""] ?? "Starting analysis"}.${progress} Results appear when this run finishes.` };
    }
    if (latest.status === "failed") return { ...common, state: "failed", message: `The latest analysis failed: ${latest.error ?? "see Collection health for details"}` };
    const [screened, eligible, warming, shortlisted, signals] = await Promise.all([
      this.prisma.screeningResult.count({ where: { runId: latest.id } }),
      this.prisma.screeningResult.count({ where: { runId: latest.id, eligible: true } }),
      this.prisma.screeningResult.count({ where: { runId: latest.id, exclusionReasons: { has: "warming_up" } } }),
      this.prisma.screeningResult.count({ where: { runId: latest.id, shortlisted: true } }),
      this.prisma.signal.count({ where: { runId: latest.id } }),
    ]);
    const analysis = latest.stages.find((s) => s.stage === "analyze")?.detail as { agentStatus?: string; summary?: string | null; notes?: string[] } | null;
    const outside = typeof m.outsideUniverse === "number" ? m.outsideUniverse : null;
    const observed = typeof m.observed === "number" ? m.observed : null;
    const state = signals ? "ready" : !eligible && warming ? "warming_up" : "no_matches";
    const scope = observed !== null && outside !== null ? `${observed} coins collected; ${outside} are outside the strategy floors; ` : "";
    const message = signals
      ? `${signals} research signal(s) available.`
      : !eligible && warming
        ? `${scope}${warming} coin(s) in the strategy universe are warming up. Screening needs ${this.cfg.SNAPSHOT_WINDOW} consecutive hourly snapshots; no prediction has been generated yet.`
        : `${scope}${screened} coins screened; ${eligible} eligible. No coins met the signal rules in this run.`;
    return { ...common, state, message, observed, outside, screened, eligible, warming, shortlisted, signals, finishedAt: latest.finishedAt, agentStatus: analysis?.agentStatus ?? null, summary: analysis?.summary ?? null, notes: analysis?.notes ?? [] };
  }

  /**
   * Dashboard overview: progress of the newest run plus the strategy funnel, market context,
   * history backfill and agent outcome of the latest published run.
   */
  async overview() {
    const providerId = this.providerId;
    const [latest, publishedId] = await Promise.all([
      this.prisma.pipelineRun.findFirst({ where: { providerId }, orderBy: [{ slotTime: "desc" }, { startedAt: "desc" }], include: { stages: { orderBy: { startedAt: "asc" } } } }),
      this.latestRunId(),
    ]);
    // A "running" run with no live lease holder was orphaned by a stopped process.
    const lease = latest?.status === "running" ? await this.prisma.jobLease.findUnique({ where: { name: "hourly-pipeline" } }) : null;
    const interrupted = latest?.status === "running" && (!lease || lease.expiresAt < new Date());
    const published = publishedId ? await this.prisma.pipelineRun.findUnique({ where: { id: publishedId }, include: { stages: { orderBy: { startedAt: "asc" } } } }) : null;
    let funnel: Record<string, unknown> | null = null;
    if (published) {
      const m = (published.metrics ?? {}) as Record<string, unknown>;
      const cov = (published.coverage ?? {}) as Record<string, unknown>;
      const [bySignal, byClass, screened, eligible, warming, shortlisted, insideReasons] = await Promise.all([
        this.prisma.signal.groupBy({ by: ["status"], where: { runId: published.id }, _count: { _all: true } }),
        this.prisma.screeningResult.groupBy({ by: ["classification"], where: { runId: published.id, eligible: true }, _count: { _all: true } }),
        this.prisma.screeningResult.count({ where: { runId: published.id } }),
        this.prisma.screeningResult.count({ where: { runId: published.id, eligible: true } }),
        this.prisma.screeningResult.count({ where: { runId: published.id, exclusionReasons: { has: "warming_up" } } }),
        this.prisma.screeningResult.count({ where: { runId: published.id, shortlisted: true } }),
        this.prisma.$queryRaw<Array<{ reason: string; n: number }>>`
          SELECT r AS reason, count(*)::int AS n FROM "ScreeningResult", unnest("exclusionReasons") AS r
          WHERE "runId" = ${published.id}::uuid GROUP BY r ORDER BY n DESC`,
      ]);
      const analyze = published.stages.find((s) => s.stage === "analyze")?.detail as Record<string, unknown> | null;
      funnel = {
        runId: published.id,
        slotTime: published.slotTime,
        finishedAt: published.finishedAt,
        status: published.status,
        listed: cov.universeSize ?? null,
        collected: cov.collected ?? null,
        coverageLabel: cov.label ?? null,
        coveragePct: cov.coveragePct ?? null,
        stale: cov.stale ?? null,
        observed: m.observed ?? cov.collected ?? null,
        outside: m.outsideUniverse ?? null,
        outsideReasons: m.outsideReasons ?? {},
        screened,
        warming,
        eligible,
        insideReasons: Object.fromEntries(insideReasons.map((r) => [r.reason, r.n])),
        classifications: Object.fromEntries(byClass.map((c) => [c.classification, c._count._all])),
        shortlisted,
        signals: Object.fromEntries(bySignal.map((s) => [s.status, s._count._all])),
        market: m.market ?? (published.stages.find((s) => s.stage === "features")?.detail as { market?: unknown } | null)?.market ?? null,
        history: m.history ?? published.stages.find((s) => s.stage === "history")?.detail ?? null,
        agent: { status: analyze?.agentStatus ?? null, summary: analyze?.summary ?? null, notes: analyze?.notes ?? [], costUsd: published.modelCostUsd },
      };
    }
    return plain<Record<string, unknown>>({
      readiness: await this.predictionStatus(),
      latestRun: latest ? { id: latest.id, slotTime: latest.slotTime, status: interrupted ? "interrupted" : latest.status, currentStage: latest.currentStage, startedAt: latest.startedAt, finishedAt: latest.finishedAt, stages: latest.stages, metrics: latest.metrics, coverage: latest.coverage, error: latest.error } : null,
      funnel,
    });
  }

  /**
   * Screening rows of one run with each coin's snapshot and key strategy features at that slot.
   * The strategy universe is ~1–2k coins, so the dashboard loads a run once and sorts locally.
   */
  async screening(q: { runId?: string; eligibleOnly: boolean; classification?: string; search?: string; limit: number; offset?: number }) {
    const runId = q.runId ?? (await this.latestRunId());
    if (!runId) return plain<Record<string, unknown>>({ runId: null, slotTime: null, total: 0, results: [] });
    const run = await this.prisma.pipelineRun.findUniqueOrThrow({ where: { id: runId }, select: { slotTime: true } });
    const where: Prisma.ScreeningResultWhereInput = {
      runId,
      ...(q.eligibleOnly ? { eligible: true } : {}),
      ...(q.classification ? { classification: q.classification } : {}),
      ...(q.search ? { asset: { OR: [{ symbol: { contains: q.search.toUpperCase() } }, { name: { contains: q.search, mode: "insensitive" } }] } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.screeningResult.count({ where }),
      this.prisma.screeningResult.findMany({
        where,
        include: { asset: { select: { name: true, symbol: true, assetClass: true, isBenchmark: true } } },
        orderBy: [{ eligible: "desc" }, { heuristicScore: "desc" }, { assetId: "asc" }],
        take: q.limit,
        skip: q.offset ?? 0,
      }),
    ]);
    const { quotes, features } = await this.quotesAndFeatures(rows.map((r) => r.assetId), run.slotTime);
    const results = rows.map((r) => ({ ...r, quote: quotes.get(r.assetId) ?? null, keyFeatures: features.get(r.assetId) ?? null }));
    return plain<Record<string, unknown>>({ runId, slotTime: run.slotTime, total, results });
  }

  /**
   * Every coin collected at the newest published slot (or the newest collected slot before the
   * first run is published), with its strategy status. Server-side search, sort and paging.
   */
  async market(q: { search?: string; sort: MarketSort; dir: "asc" | "desc"; scope: "all" | "universe" | "outside"; limit: number; offset: number }) {
    const providerId = this.providerId;
    const publishedId = await this.latestRunId();
    const published = publishedId ? await this.prisma.pipelineRun.findUnique({ where: { id: publishedId }, select: { id: true, slotTime: true } }) : null;
    const slotTime = published?.slotTime ?? (await this.prisma.marketSnapshot.findFirst({ where: { providerId }, orderBy: { slotTime: "desc" }, select: { slotTime: true } }))?.slotTime;
    if (!slotTime) return plain<Record<string, unknown>>({ slotTime: null, runId: null, total: 0, offset: q.offset, coins: [] });
    const floor = { marketCap: { gte: this.cfg.MIN_MARKET_CAP_USD } };
    const excluded = [...EXCLUDED_CLASSES];
    const scopeWhere: Prisma.MarketSnapshotWhereInput =
      q.scope === "universe"
        ? { OR: [{ asset: { isBenchmark: true } }, { ...floor, asset: { assetClass: { notIn: excluded } } }] }
        : q.scope === "outside"
          ? { asset: { isBenchmark: false }, OR: [{ marketCap: null }, { marketCap: { lt: this.cfg.MIN_MARKET_CAP_USD } }, { asset: { assetClass: { in: excluded } } }] }
          : {};
    const where: Prisma.MarketSnapshotWhereInput = {
      providerId,
      slotTime,
      ...(q.search ? { asset: { OR: [{ symbol: { contains: q.search.toUpperCase() } }, { name: { contains: q.search, mode: "insensitive" } }] } } : {}),
      ...(q.scope === "all" ? {} : { AND: [scopeWhere] }),
    };
    const nulls = { sort: q.dir, nulls: "last" } as const;
    const orderBy: Prisma.MarketSnapshotOrderByWithRelationInput[] =
      q.sort === "symbol" ? [{ asset: { symbol: q.dir } }] :
      q.sort === "volume" ? [{ volumeRolling24h: nulls }] :
      q.sort === "change_1h" ? [{ providerChangePct1h: nulls }] :
      q.sort === "change_24h" ? [{ providerChangePct24h: nulls }] :
      q.sort === "change_7d" ? [{ providerChangePct7d: nulls }] :
      [{ marketCap: nulls }];
    const [total, rows] = await Promise.all([
      this.prisma.marketSnapshot.count({ where }),
      this.prisma.marketSnapshot.findMany({
        where,
        orderBy: [...orderBy, { providerAssetId: "asc" }],
        take: q.limit,
        skip: q.offset,
        select: {
          assetId: true, providerAssetId: true, price: true, marketCap: true, marketCapProvenance: true, volumeRolling24h: true, providerChangePct1h: true, providerChangePct24h: true, providerChangePct7d: true,
          circulatingSupply: true, observedAt: true, isStale: true, qualityFlags: true, sourceUrl: true,
          asset: { select: { name: true, symbol: true, assetClass: true, isBenchmark: true } },
        },
      }),
    ]);
    const screened = published
      ? await this.prisma.screeningResult.findMany({ where: { runId: published.id, assetId: { in: rows.map((r) => r.assetId) } }, select: { assetId: true, eligible: true, classification: true, heuristicScore: true, exclusionReasons: true, shortlisted: true, rank: true } })
      : [];
    const byAsset = new Map(screened.map((s) => [s.assetId, s]));
    const coins = rows.map((r) => {
      const latest = { price: toNum(r.price), marketCap: toNum(r.marketCap), volumeRolling24h: toNum(r.volumeRolling24h), isStale: r.isStale };
      const s = byAsset.get(r.assetId);
      return {
        ...r,
        strategy: inScreenUniverse(r.asset, latest, this.floors)
          ? { inUniverse: true, screened: !!s, eligible: s?.eligible ?? null, classification: s?.classification ?? null, score: s ? toNum(s.heuristicScore) : null, shortlisted: s?.shortlisted ?? false, rank: s?.rank ?? null, reasons: s?.exclusionReasons ?? [] }
          : { inUniverse: false, screened: false, eligible: false, classification: null, score: null, shortlisted: false, rank: null, reasons: eligibilityExclusions(r.asset, latest, this.floors) },
      };
    });
    return plain<Record<string, unknown>>({ slotTime, runId: published?.id ?? null, total, offset: q.offset, coins });
  }

  /**
   * Pump recommendations of one run: eligible coins with a high or medium strategy pump chance
   * (plus anything shortlisted), ordered by chance then score, with price, the last three days,
   * market cap, volume / market cap vs the six-month baseline, the agents' own stance and the
   * combined recommendation. Shared by the dashboard, MCP and the Telegram table.
   */
  async recommendations(q: { runId?: string; limit?: number } = {}) {
    const runId = q.runId ?? (await this.latestRunId());
    if (!runId) return plain<Record<string, unknown>>({ runId: null, slotTime: null, rows: [] });
    const run = await this.prisma.pipelineRun.findUniqueOrThrow({ where: { id: runId }, select: { slotTime: true, providerId: true } });
    const candidates = await this.prisma.screeningResult.findMany({
      where: { runId, eligible: true, OR: [{ pumpChance: { in: ["high", "medium"] } }, { shortlisted: true }] },
      include: { asset: { select: { name: true, symbol: true } } },
    });
    const top = candidates
      .map((c) => ({ ...c, heuristicScore: toNum(c.heuristicScore) ?? 0, pumpChance: c.pumpChance as PumpChance }))
      .sort(byPumpChance)
      .slice(0, q.limit ?? this.cfg.RECOMMENDATIONS_MAX);
    const ids = top.map((r) => r.assetId);
    const [snaps, window72, signals, cmc] = await Promise.all([
      this.prisma.marketSnapshot.findMany({ where: { providerId: run.providerId, slotTime: run.slotTime, assetId: { in: ids } } }),
      this.prisma.marketSnapshot.findMany({ where: { providerId: run.providerId, assetId: { in: ids }, slotTime: { gte: addHours(run.slotTime, -72), lte: run.slotTime } }, select: { assetId: true, slotTime: true, price: true } }),
      this.prisma.signal.findMany({ where: { runId, assetId: { in: ids } } }),
      cmcIdsFor(this.prisma, run.providerId, ids),
    ]);
    const baselines = await latestBaselines(this.prisma, [...cmc.values()]);
    const snapBy = new Map(snaps.map((x) => [x.assetId, x]));
    const sigBy = new Map(signals.map((x) => [x.assetId, x]));
    const rows = top.map((r) => {
      const snap = snapBy.get(r.assetId);
      const sig = sigBy.get(r.assetId);
      const vol = toNum(snap?.volumeRolling24h), cap = toNum(snap?.marketCap);
      const sc = (sig?.scenario ?? null) as { entryTriggerPrice?: number; stopPrice?: number; targetPrice?: number; signalExpiresAt?: string } | null;
      const final = sig?.recommendation
        ? { recommendation: sig.recommendation, reason: sig.recommendationReason ?? "" }
        : combineRecommendation({ pumpChance: r.pumpChance, status: "watch", agentRecommendation: null, reviewOutcome: null });
      return {
        assetId: r.assetId,
        symbol: r.asset.symbol,
        name: r.asset.name,
        cmcId: cmc.get(r.assetId) ?? null,
        rank: r.rank,
        shortlisted: r.shortlisted,
        classification: r.classification,
        heuristicScore: r.heuristicScore,
        pumpChance: r.pumpChance,
        pumpReasons: r.pumpReasons,
        riskFlags: r.riskFlags,
        price: toNum(snap?.price),
        marketCap: cap,
        volume24h: vol,
        change1h: toNum(snap?.providerChangePct1h),
        change24h: toNum(snap?.providerChangePct24h),
        change7d: toNum(snap?.providerChangePct7d),
        observedAt: snap?.observedAt ?? null,
        sourceUrl: snap?.sourceUrl ?? null,
        threeDay: threeDayStats(window72.filter((w) => w.assetId === r.assetId).map((w) => ({ slotTime: w.slotTime, price: toNum(w.price) })), run.slotTime),
        vmc: cmc.has(r.assetId) ? vmcContext(vol !== null && cap ? vol / cap : null, baselines.get(cmc.get(r.assetId)!) ?? null) : null,
        agent: sig
          ? { status: sig.status, recommendation: sig.agentRecommendation, reason: sig.agentRecommendationReason, origin: sig.origin, reviewOutcome: sig.reviewOutcome, agentScore: toNum(sig.agentScore), rationale: sig.rationale }
          : null,
        recommendation: final.recommendation,
        recommendationReason: final.reason,
        scenario: sc && typeof sc.entryTriggerPrice === "number" ? { entryPrice: sc.entryTriggerPrice, stopPrice: sc.stopPrice ?? null, targetPrice: sc.targetPrice ?? null, expiresAt: sc.signalExpiresAt ?? null } : null,
      };
    });
    return plain<Record<string, unknown>>({ runId, slotTime: run.slotTime, rows });
  }

  async runs(limit: number) {
    const rows = await this.prisma.pipelineRun.findMany({
      where: { providerId: this.providerId },
      orderBy: { slotTime: "desc" },
      take: limit,
      include: { stages: { orderBy: { startedAt: "asc" } } },
    });
    return plain<Record<string, unknown>[]>(rows);
  }

  async agentExecutions(runId: string) {
    const rows = await this.prisma.agentExecution.findMany({
      where: { runId },
      orderBy: { startedAt: "asc" },
      select: { id: true, role: true, model: true, provider: true, status: true, escalated: true, durationMs: true, numTurns: true, inputTokens: true, outputTokens: true, costUsd: true, errorKind: true, errorMessage: true, toolCalls: true },
    });
    return plain<Record<string, unknown>[]>(rows);
  }

  async paper() {
    const rows = await this.prisma.paperPosition.findMany({
      where: { signal: { run: { providerId: this.providerId } } },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { signal: { select: { slotTime: true, status: true, signalType: true, asset: { select: { symbol: true, name: true } } } } },
    });
    const closed = rows.filter((r) => r.status === "closed" && r.netReturn !== null);
    const net = closed.map((r) => r.netReturn!.toNumber());
    return plain<Record<string, unknown>>({
      positions: rows,
      summary: {
        total: rows.length,
        open: rows.filter((r) => r.status === "open").length,
        pendingEntry: rows.filter((r) => r.status === "pending_entry").length,
        closed: closed.length,
        expiredWithoutEntry: rows.filter((r) => r.status === "expired").length,
        winRate: net.length ? net.filter((x) => x > 0).length / net.length : null,
        avgNetReturn: net.length ? net.reduce((a, b) => a + b, 0) / net.length : null,
        ambiguousOrdering: rows.filter((r) => r.ambiguousOrdering).length,
        note: "Paper trades only. Hourly snapshots: intrahour stops/targets are unobserved.",
      },
    });
  }

  async latestBacktest() {
    return plain<Record<string, unknown> | null>(await this.prisma.backtestReport.findFirst({ orderBy: { createdAt: "desc" } }));
  }

  async deliveries(limit: number) {
    const rows = await this.prisma.telegramDelivery.findMany({
      where: { run: { providerId: this.providerId } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, runId: true, partIndex: true, partCount: true, mode: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true, text: true },
    });
    return plain<Record<string, unknown>[]>(rows);
  }

  /**
   * Newest run whose deterministic strategy results exist (screen succeeded). Agents, VMC and
   * publish may still be running or skipped: the panel shows strategy results as soon as they exist.
   */
  async latestRunId(): Promise<string | null> {
    const r = await this.prisma.pipelineRun.findFirst({
      where: { providerId: this.providerId, stages: { some: { stage: "screen", status: "succeeded" } } },
      orderBy: [{ slotTime: "desc" }, { startedAt: "desc" }],
      select: { id: true },
    });
    return r?.id ?? null;
  }
}

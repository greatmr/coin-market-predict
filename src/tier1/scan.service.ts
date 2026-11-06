import { Inject, Injectable, Logger } from "@nestjs/common";
import { D, dec, type DValue, forStorage, sha256 } from "../common/decimal.js";
import { addDays, isoDate, parseIsoDate } from "../common/dates.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { type BatchStatus, LBANK, type PassWindow, type QueueStatus, REASON, RULES, RULESET_VERSION, type WindowDays } from "./constants.js";
import { classify, type ClassResult, evaluateEligibility, type EligibilityResult, needsDailyRows } from "./eligibility.js";
import { buildLbankContext, type DecisionKind, type LbankCrawlView, type LbankResolution, type PairHistoryView, resolveLbank, type VenueDecisionView, type VenuePair } from "./lbank.js";
import { loadOverrides, type Overrides } from "./overrides.js";
import { compareQueue, inReviewQueue } from "./queue.js";
import { type AssetMarketsView, venueSummary, type VenueSummary } from "./venues.js";
import { type Comparison, type CurrentResult, type DailyInput, evaluateVmc, notEvaluated, type WindowResult } from "./vmc.js";

/** One asset of a batch with everything that does not need daily rows (class, LBank, eligibility). */
export interface PreEvaluation {
  cmcId: number;
  symbol: string;
  name: string;
  slug: string | null;
  rank: number | null;
  dateAdded: Date | null;
  tags: string[];
  price: DValue | null;
  cap: DValue | null;
  capProviderReported: boolean;
  volume24h: DValue | null;
  observedAt: Date | null;
  collectedAt: Date;
  sourceUrl: string;
  cls: ClassResult;
  lbank: LbankResolution;
  eligibility: EligibilityResult;
  decisionIds: string[];
  /** Current VMC from the batch quote (used to order daily refreshes, never a filter). */
  currentVmc: DValue | null;
}

export interface BatchContext {
  batch: { id: string; providerId: string; slotTime: Date; crawledAt: Date; status: BatchStatus; statusReasons: string[]; isLive: boolean };
  asOf: Date;
  overrides: Overrides;
  lbankCrawl: { id: string; status: string; finishedAt: Date; fresh: boolean; pairs: number } | null;
  assets: PreEvaluation[];
  maxQuoteAgeMs: number;
}

export interface ScanOutcome {
  batchId: string;
  status: "succeeded" | "failed";
  queueStatus: QueueStatus;
  counts: Record<string, unknown>;
  warnings: string[];
  venueCandidates: Array<{ cmcId: number; slug: string | null }>;
}

const MINUTE = 60_000;
const n = (v: { toString(): string } | null | undefined) => dec(v ?? null);

export function configVersion(cfg: AppConfig, overrides: Overrides): string {
  return sha256(JSON.stringify({ RULESET_VERSION, RULES, maxQuoteAgeMinutes: cfg.MAX_QUOTE_AGE_MINUTES, lbankMaxAgeDays: cfg.LBANK_PAIRS_MAX_AGE_DAYS, lbankManualVerification: cfg.LBANK_REQUIRE_MANUAL_VERIFICATION, overrides: overrides.hash })).slice(0, 12);
}

/**
 * Tier 1 scan of one crawl batch (PDF p.9–14, p.16). Pure rules from `vmc.ts`, `eligibility.ts`,
 * `lbank.ts` and `queue.ts`; this service only loads stored inputs and persists results.
 */
@Injectable()
export class ScanService {
  private readonly log = new Logger(ScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get maxQuoteAgeMs() {
    return this.cfg.MAX_QUOTE_AGE_MINUTES * MINUTE;
  }

  async latestBatch(providerId: string) {
    return this.prisma.crawlBatch.findFirst({ where: { providerId, status: { not: "FAILED" } }, orderBy: { slotTime: "desc" } });
  }

  /** Inputs of one batch as stored, plus the evaluation that needs no daily rows. */
  async loadContext(batchId: string): Promise<BatchContext> {
    const b = await this.prisma.crawlBatch.findUniqueOrThrow({ where: { id: batchId } });
    const asOf = b.crawledAt;
    const overrides = loadOverrides(this.cfg.TIER1_OVERRIDES_FILE);
    const snaps = await this.prisma.marketSnapshot.findMany({
      where: { providerId: b.providerId, slotTime: b.slotTime },
      select: { providerAssetId: true, price: true, marketCap: true, marketCapProvenance: true, volumeRolling24h: true, observedAt: true, collectedAt: true, rank: true, dateAdded: true, tags: true, sourceUrl: true, asset: { select: { symbol: true, name: true, assetClass: true, classSource: true } } },
    });
    const cmcIds = snaps.map((s) => Number(s.providerAssetId)).filter((x) => Number.isSafeInteger(x));
    const cmc = new Map((await this.prisma.cmcAsset.findMany({ where: { providerId: b.providerId, cmcId: { in: cmcIds } }, select: { cmcId: true, symbol: true, name: true, slug: true } })).map((a) => [a.cmcId, a]));

    // LBank Spot markets list = reference data refreshed every LBANK_PAIRS_REFRESH_DAYS or on demand
    // (D2): the newest COMPLETE list available when the scan runs, stale beyond
    // LBANK_PAIRS_MAX_AGE_DAYS. Without any complete list, the newest attempt explains why.
    const crawlRow =
      (await this.prisma.venueCrawl.findFirst({ where: { providerId: b.providerId, kind: "lbank_spot_pairs", status: "COMPLETE" }, orderBy: { finishedAt: "desc" } })) ??
      (await this.prisma.venueCrawl.findFirst({ where: { providerId: b.providerId, kind: "lbank_spot_pairs" }, orderBy: { finishedAt: "desc" } }));
    const crawlView: LbankCrawlView | null = crawlRow ? { id: crawlRow.id, status: crawlRow.status as LbankCrawlView["status"], finishedAt: crawlRow.finishedAt, pairs: (crawlRow.pairs ?? []) as unknown as VenuePair[] } : null;
    const lctx = buildLbankContext(crawlView, asOf, this.cfg.LBANK_PAIRS_MAX_AGE_DAYS * 86_400_000, { listingIsTradable: !this.cfg.LBANK_REQUIRE_MANUAL_VERIFICATION });

    const decisions = new Map<number, VenueDecisionView[]>();
    for (const d of await this.prisma.venueDecision.findMany({ where: { providerId: b.providerId, exchange: LBANK } })) {
      decisions.set(d.cmcId, [...(decisions.get(d.cmcId) ?? []), { id: d.id, marketPair: d.marketPair, decision: d.decision as DecisionKind, decidedAt: d.decidedAt, reviewer: d.reviewer, source: "review" }]);
    }
    const history = new Map<number, { lastAbsentAt: Map<string, Date>; everListed: Set<string> }>();
    if (crawlView) {
      for (const e of await this.prisma.venuePairEvent.findMany({ where: { providerId: b.providerId, exchange: LBANK, at: { lte: crawlView.finishedAt } }, orderBy: { at: "asc" } })) {
        const h = history.get(e.cmcId) ?? { lastAbsentAt: new Map(), everListed: new Set() };
        if (e.event === "LISTED") h.everListed.add(e.marketPair);
        else h.lastAbsentAt.set(e.marketPair, e.at);
        history.set(e.cmcId, h);
      }
    }
    const rankCounts = new Map<number, number>();
    for (const s of snaps) if (s.rank !== null) rankCounts.set(s.rank, (rankCounts.get(s.rank) ?? 0) + 1);
    const noHistory: PairHistoryView = { lastAbsentAt: new Map(), everListed: new Set() };

    const assets: PreEvaluation[] = [];
    for (const s of snaps) {
      const cmcId = Number(s.providerAssetId);
      if (!Number.isSafeInteger(cmcId) || cmcId <= 0) continue;
      const meta = cmc.get(cmcId);
      const symbol = meta?.symbol ?? s.asset.symbol;
      const cls = classify({ tags: s.tags, heuristicClass: s.asset.assetClass, heuristicSource: s.asset.classSource, override: overrides.classFor(b.providerId, cmcId) });
      const decs = [...(decisions.get(cmcId) ?? []), ...overrides.lbankDecisionsFor(b.providerId, cmcId)];
      const lbank = resolveLbank(cmcId, symbol, lctx, decs, history.get(cmcId) ?? noHistory);
      const cap = n(s.marketCap);
      const capProviderReported = s.marketCapProvenance === "provider_reported";
      const volume24h = n(s.volumeRolling24h);
      const eligibility = evaluateEligibility({ rank: s.rank, rankDuplicate: s.rank !== null && (rankCounts.get(s.rank) ?? 0) > 1, capUsd: cap, capProviderReported, dateAdded: s.dateAdded, asOf, cls, lbank: { status: lbank.status, reason: lbank.reason } });
      assets.push({
        cmcId, symbol, name: meta?.name ?? s.asset.name, slug: meta?.slug ?? null, rank: s.rank, dateAdded: s.dateAdded, tags: s.tags,
        price: n(s.price), cap, capProviderReported, volume24h, observedAt: s.observedAt, collectedAt: s.collectedAt, sourceUrl: s.sourceUrl,
        cls, lbank, eligibility, decisionIds: [...new Set(lbank.pairs.flatMap((p) => p.decisionIds))],
        currentVmc: cap && cap.gt(0) && capProviderReported && volume24h && !volume24h.isNegative() ? volume24h.div(cap) : null,
      });
    }
    return {
      batch: { id: b.id, providerId: b.providerId, slotTime: b.slotTime, crawledAt: b.crawledAt, status: b.status as BatchStatus, statusReasons: b.statusReasons, isLive: b.isLive },
      asOf,
      overrides,
      lbankCrawl: crawlRow ? { id: crawlRow.id, status: crawlRow.status, finishedAt: crawlRow.finishedAt, fresh: lctx.fresh, pairs: crawlRow.fetchedCount } : null,
      assets,
      maxQuoteAgeMs: this.maxQuoteAgeMs,
    };
  }

  /** Assets whose completed daily rows are needed (not excluded), most relevant first. */
  dailyCandidates(ctx: BatchContext): Array<{ cmcId: number; slug: string | null }> {
    const tier = (a: PreEvaluation) => (a.lbank.status === "VERIFIED" ? 0 : a.lbank.status === "PAIR_LISTED_UNVERIFIED" ? 1 : 2);
    return ctx.assets
      .filter((a) => needsDailyRows(a.eligibility))
      .sort((a, b) => tier(a) - tier(b) || (b.currentVmc && a.currentVmc ? b.currentVmc.cmp(a.currentVmc) : a.currentVmc ? -1 : b.currentVmc ? 1 : 0) || a.cmcId - b.cmcId)
      .map((a) => ({ cmcId: a.cmcId, slug: a.slug }));
  }

  /** Evaluate and persist every asset of the batch; reprocessing replaces the batch's rows. */
  async scan(batchId: string, extraWarnings: string[] = []): Promise<ScanOutcome> {
    const startedAt = new Date();
    const ctx = await this.loadContext(batchId);
    const { batch, asOf } = ctx;
    const cv = configVersion(this.cfg, ctx.overrides);
    await this.prisma.scanRun.upsert({
      where: { batchId },
      create: { batchId, providerId: batch.providerId, isLive: batch.isLive, rulesetVersion: RULESET_VERSION, configVersion: cv, overridesVersion: ctx.overrides.version, startedAt, status: "running", asOf },
      update: { status: "running", startedAt, finishedAt: null, attempts: { increment: 1 }, rulesetVersion: RULESET_VERSION, configVersion: cv, overridesVersion: ctx.overrides.version, error: null },
    });
    try {
      const outcome = await this.evaluateAndPersist(ctx, cv, extraWarnings);
      this.log.log(`scan ${batch.slotTime.toISOString()}: ${JSON.stringify({ eligible: outcome.counts.eligible, needsReview: outcome.counts.needsReview, excluded: outcome.counts.excluded, queue: outcome.counts.queue, queueStatus: outcome.queueStatus })}`);
      return outcome;
    } catch (err) {
      await this.prisma.scanRun.update({ where: { batchId }, data: { status: "failed", finishedAt: new Date(), error: redact(err).slice(0, 2000) } });
      throw err;
    }
  }

  private async evaluateAndPersist(ctx: BatchContext, cv: string, extraWarnings: string[]): Promise<ScanOutcome> {
    const { batch, asOf } = ctx;
    const computedAt = new Date();
    const evaluated = ctx.assets.filter((a) => needsDailyRows(a.eligibility));
    const daily = await this.dailyInputs(batch.providerId, evaluated.map((a) => a.cmcId), asOf);
    const markets = await this.latestAssetMarkets(batch.providerId, evaluated.map((a) => a.cmcId));
    const venueMaxAge = 2 * this.cfg.TIER1_VENUE_REFRESH_HOURS * 3_600_000;

    type Row = Prisma.ScanResultCreateManyInput & { _m3: DValue | null };
    const rows: Row[] = [];
    for (const a of ctx.assets) {
      const isEvaluated = needsDailyRows(a.eligibility);
      const rowsFor = daily.get(a.cmcId) ?? new Map<string, DailyInput>();
      const currentInput = { present: true, volume24h: a.volume24h, marketCap: a.cap, capProviderReported: a.capProviderReported, observedAt: a.observedAt, collectedAt: a.collectedAt, sameObservation: true };
      const ev = evaluateVmc(asOf, rowsFor, currentInput, ctx.maxQuoteAgeMs);
      const comparisons: Record<PassWindow, Comparison> = isEvaluated ? ev.comparisons : notEvaluated();
      const windows = ev.windows;
      const stars = isEvaluated ? ev.stars : 0;
      const venue: VenueSummary | null = isEvaluated ? venueSummary(a.cmcId, markets.get(a.cmcId) ?? null, computedAt, venueMaxAge) : null;
      const flags = this.flagsFor(a, ev.current, windows, isEvaluated, batch.status);
      const avg = (d: WindowDays) => (isEvaluated ? forStorage(windows[d].mean) : null);
      const avgReason = (d: WindowDays) => (isEvaluated ? windows[d].reason : REASON.notEvaluated);
      const window30 = windows[30];
      const lineage = isEvaluated ? { asOfDate: isoDate(asOf), dates: window30.dates, revisionIds: window30.revisionIds.map((x) => (x === null ? null : Number(x))), missingDates: window30.missingDates, invalidDates: window30.invalidDates } : null;
      const inputs = {
        snapshot: [a.rank, a.cap?.toFixed() ?? null, a.capProviderReported, a.volume24h?.toFixed() ?? null, a.price?.toFixed() ?? null, a.observedAt?.toISOString() ?? null, a.collectedAt.toISOString(), a.dateAdded?.toISOString() ?? null, [...a.tags].sort()],
        cls: [a.cls.assetClass, a.cls.kind, a.cls.source],
        lbank: [a.lbank.status, a.lbank.reason, a.decisionIds.sort(), ctx.lbankCrawl?.id ?? null],
        daily: lineage?.revisionIds ?? null,
        overrides: ctx.overrides.hash,
        ruleset: RULESET_VERSION,
      };
      rows.push({
        batchId: batch.id,
        providerId: batch.providerId,
        cmcId: a.cmcId,
        symbol: a.symbol,
        name: a.name,
        slug: a.slug,
        rank: a.rank,
        dateAdded: a.dateAdded,
        ageDays: a.eligibility.ageDays ? a.eligibility.ageDays.toDecimalPlaces(6).toFixed() : null,
        priceUsd: a.price?.toFixed() ?? null,
        capUsd: a.cap?.toFixed() ?? null,
        volume24hUsd: a.volume24h?.toFixed() ?? null,
        observedAt: a.observedAt,
        crawledAt: a.collectedAt,
        currentStatus: ev.current.status,
        currentReason: ev.current.reason,
        currentVmc: forStorage(ev.current.vmc),
        vmc3dAvg: avg(3), vmc7dAvg: avg(7), vmc14dAvg: avg(14), vmc30dAvg: avg(30),
        avg3dReason: avgReason(3), avg7dReason: avgReason(7), avg14dReason: avgReason(14), avg30dReason: avgReason(30),
        multiple3d: forStorage(comparisons[3].multiple), multiple7d: forStorage(comparisons[7].multiple), multiple30d: forStorage(comparisons[30].multiple),
        pass3d: comparisons[3].status, pass7d: comparisons[7].status, pass30d: comparisons[30].status,
        reason3d: comparisons[3].reason, reason7d: comparisons[7].reason, reason30d: comparisons[30].reason,
        stars,
        eligibilityStatus: a.eligibility.status,
        eligibilityReasons: a.eligibility.reasons,
        assetClass: a.cls.assetClass,
        classSource: a.cls.kind ? `${a.cls.source} (${a.cls.kind})` : a.cls.source,
        lbankStatus: a.lbank.status,
        lbankReason: a.lbank.reason,
        lbankPairs: a.lbank.pairs as never,
        venueReview: "PENDING",
        venueFlags: venue?.flags ?? [],
        flags,
        inQueue: false,
        queueOrder: null,
        diagnostics: (isEvaluated
          ? {
              quoteAgeSeconds: ev.current.quoteAgeMs === null ? null : Math.round(ev.current.quoteAgeMs / 1000),
              volumeAvg: Object.fromEntries(RULES.windows.map((d) => [d, forStorage(ev.diagnostics.volumeAvg[d])])),
              volumeRatio24h: Object.fromEntries(RULES.windows.map((d) => [d, forStorage(ev.diagnostics.volumeRatio24h[d])])),
              venue,
              classEvidence: a.cls.evidence,
            }
          : { quoteAgeSeconds: ev.current.quoteAgeMs === null ? null : Math.round(ev.current.quoteAgeMs / 1000) }) as never,
        dailyWindow: (lineage ?? undefined) as never,
        inputsHash: sha256(JSON.stringify(inputs)).slice(0, 32),
        rulesetVersion: RULESET_VERSION,
        configVersion: cv,
        computedAt,
        _m3: comparisons[3].multiple,
      });
    }

    const queue = rows.filter((r) => inReviewQueue({ eligibilityStatus: r.eligibilityStatus, stars: r.stars }));
    queue.sort((x, y) => compareQueue({ cmcId: x.cmcId, pass3d: x.pass3d as never, pass7d: x.pass7d as never, pass30d: x.pass30d as never, multiple3d: x._m3 }, { cmcId: y.cmcId, pass3d: y.pass3d as never, pass7d: y.pass7d as never, pass30d: y.pass30d as never, multiple3d: y._m3 }));
    queue.forEach((r, i) => {
      r.inQueue = true;
      r.queueOrder = i + 1;
    });
    const lbankUnavailable = !ctx.lbankCrawl || ctx.lbankCrawl.status !== "COMPLETE" || !ctx.lbankCrawl.fresh;
    const queueStatus: QueueStatus = batch.status !== "COMPLETE" ? "WITHHELD_INCOMPLETE_BATCH" : lbankUnavailable ? "WITHHELD_LBANK_UNAVAILABLE" : queue.length ? "PUBLISHED" : "EMPTY";

    const counts = await this.countsAndWarnings(ctx, rows, queue.length, extraWarnings);
    const tasks = ctx.assets.flatMap((a) => a.lbank.tasks.map((t) => ({ ...t, cmcId: a.cmcId })));
    const persistable = rows.map(({ _m3, ...r }) => r);
    await this.prisma.$transaction(
      async (tx) => {
        await tx.scanResult.deleteMany({ where: { batchId: batch.id } });
        for (let i = 0; i < persistable.length; i += 1000) await tx.scanResult.createMany({ data: persistable.slice(i, i + 1000) });
        for (const t of tasks) {
          await tx.venueMappingTask.upsert({
            where: { providerId_cmcId_exchange_marketPair_kind: { providerId: batch.providerId, cmcId: t.cmcId, exchange: LBANK, marketPair: t.marketPair, kind: t.kind } },
            create: { providerId: batch.providerId, cmcId: t.cmcId, exchange: LBANK, marketPair: t.marketPair, kind: t.kind, evidence: t.evidence as never, status: "OPEN", firstSeenBatchId: batch.id, lastSeenBatchId: batch.id },
            update: { evidence: t.evidence as never, lastSeenBatchId: batch.id },
          });
        }
        // A task whose mapping is no longer ambiguous for an asset of this batch (decision recorded,
        // pair gone) is resolved; tasks of assets outside the batch are left as they are.
        const open = await tx.venueMappingTask.findMany({ where: { providerId: batch.providerId, status: "OPEN", cmcId: { in: ctx.assets.map((a) => a.cmcId) } }, select: { id: true, cmcId: true, marketPair: true, kind: true } });
        const live = new Set(tasks.map((t) => `${t.cmcId}|${t.marketPair}|${t.kind}`));
        const resolved = open.filter((t) => !live.has(`${t.cmcId}|${t.marketPair}|${t.kind}`)).map((t) => t.id);
        if (resolved.length) await tx.venueMappingTask.updateMany({ where: { id: { in: resolved } }, data: { status: "RESOLVED", resolvedAt: new Date() } });
        await tx.scanRun.update({ where: { batchId: batch.id }, data: { status: "succeeded", finishedAt: new Date(), queueStatus, counts: counts.counts as never, warnings: counts.warnings, lbankCrawlId: ctx.lbankCrawl?.id ?? null } });
      },
      { timeout: 120_000 },
    );
    const venueCandidates = rows
      .filter((r) => r.inQueue || (r.eligibilityStatus === "NEEDS_REVIEW" && r.stars > 0))
      .sort((x, y) => (x.queueOrder ?? 1e9) - (y.queueOrder ?? 1e9) || y.stars - x.stars || x.cmcId - y.cmcId)
      .map((r) => ({ cmcId: r.cmcId, slug: r.slug ?? null }));
    return { batchId: batch.id, status: "succeeded", queueStatus, counts: counts.counts, warnings: counts.warnings, venueCandidates };
  }

  private flagsFor(a: PreEvaluation, current: CurrentResult, windows: Record<WindowDays, WindowResult>, evaluated: boolean, batchStatus: BatchStatus): string[] {
    const f: string[] = [];
    if (batchStatus !== "COMPLETE") f.push("BATCH_INCOMPLETE");
    if (current.status !== "OK") f.push(`CURRENT_${current.status}`);
    if (!a.capProviderReported && a.cap) f.push("CAP_NOT_PROVIDER_REPORTED");
    if (evaluated && windows[30].missingDates.length) f.push(`DAILY_MISSING:${windows[30].missingDates.length}`);
    if (evaluated && windows[30].invalidDates.length) f.push(`DAILY_INVALID:${windows[30].invalidDates.length}`);
    if (a.lbank.status === "PAIR_LISTED_UNVERIFIED") f.push("LBANK_PAIR_UNVERIFIED");
    if (a.lbank.tasks.length) f.push("LBANK_MAPPING_TASK");
    if (a.cls.source.startsWith("override")) f.push("CLASS_OVERRIDE");
    return f;
  }

  /** Effective daily rows for T−lookback … T−1 keyed by asset and date. */
  private async dailyInputs(providerId: string, cmcIds: number[], asOf: Date): Promise<Map<number, Map<string, DailyInput>>> {
    const out = new Map<number, Map<string, DailyInput>>();
    if (!cmcIds.length) return out;
    const today = isoDate(asOf);
    const from = parseIsoDate(addDays(today, -Math.max(this.cfg.TIER1_DAILY_LOOKBACK_DAYS, RULES.requiredDailyRows)));
    const to = parseIsoDate(addDays(today, -1));
    for (let i = 0; i < cmcIds.length; i += 2000) {
      const rows = await this.prisma.dailyMetric.findMany({ where: { providerId, cmcId: { in: cmcIds.slice(i, i + 2000) }, dateUtc: { gte: from, lte: to } }, select: { cmcId: true, dateUtc: true, volumeUsd: true, marketCapUsd: true, valid: true, invalidReasons: true, revisionId: true, closeUsd: true } });
      for (const r of rows) {
        const date = isoDate(r.dateUtc);
        const m = out.get(r.cmcId) ?? new Map<string, DailyInput>();
        m.set(date, { dateUtc: date, volume: n(r.volumeUsd), marketCap: n(r.marketCapUsd), valid: r.valid, invalidReasons: r.invalidReasons, revisionId: r.revisionId.toString(), close: n(r.closeUsd) });
        out.set(r.cmcId, m);
      }
    }
    return out;
  }

  private async latestAssetMarkets(providerId: string, cmcIds: number[]): Promise<Map<number, AssetMarketsView>> {
    if (!cmcIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ id: string; cmcId: number; status: string; finishedAt: Date; expectedCount: number | null; fetchedCount: number; pairs: unknown }>>`
      SELECT DISTINCT ON ("cmcId") id, "cmcId", status, "finishedAt", "expectedCount", "fetchedCount", pairs
      FROM "VenueCrawl" WHERE "providerId" = ${providerId} AND kind = 'asset_markets' AND "cmcId" = ANY(${cmcIds}::int[])
      ORDER BY "cmcId", "finishedAt" DESC`;
    return new Map(rows.map((r) => [r.cmcId, { id: r.id, status: r.status as AssetMarketsView["status"], finishedAt: r.finishedAt, expectedCount: r.expectedCount, fetchedCount: r.fetchedCount, pairs: (r.pairs ?? []) as VenuePair[] }]));
  }

  /** Run counts and observability warnings (PDF p.18). Counts and comparisons only; no thresholds. */
  private async countsAndWarnings(ctx: BatchContext, rows: Array<Prisma.ScanResultCreateManyInput>, queue: number, extra: string[]) {
    const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
    const evaluated = rows.filter((r) => r.eligibilityStatus !== "EXCLUDED");
    const counts: Record<string, unknown> = {
      assets: rows.length,
      eligible: rows.filter((r) => r.eligibilityStatus === "ELIGIBLE").length,
      needsReview: rows.filter((r) => r.eligibilityStatus === "NEEDS_REVIEW").length,
      excluded: rows.filter((r) => r.eligibilityStatus === "EXCLUDED").length,
      queue,
      evaluated: evaluated.length,
      stars: tally(evaluated.map((r) => String(r.stars))),
      pass: Object.fromEntries((["pass3d", "pass7d", "pass30d"] as const).map((k) => [k, tally(evaluated.map((r) => r[k] as string))])),
      notAvailable: Object.fromEntries((["reason3d", "reason7d", "reason30d"] as const).map((k) => [k, tally(evaluated.map((r) => r[k] as string | null).filter((x): x is string => !!x))])),
      current: tally(rows.map((r) => r.currentStatus)),
      lbank: tally(rows.map((r) => r.lbankStatus)),
      reasons: tally(rows.flatMap((r) => (r.eligibilityReasons as string[]).map((x) => x.split(":")[0]!))),
      batchStatus: ctx.batch.status,
      lbankCrawl: ctx.lbankCrawl,
      overridesVersion: ctx.overrides.version,
      mappingTasks: ctx.assets.reduce((s, a) => s + a.lbank.tasks.length, 0),
    };
    const warnings = [...extra];
    if (ctx.batch.status !== "COMPLETE") warnings.push(`INCOMPLETE_UNIVERSE: batch ${ctx.batch.status} (${ctx.batch.statusReasons.join(", ")}); the Review Queue is not complete`);
    if (!ctx.lbankCrawl) warnings.push("LBANK_FEED_MISSING: no LBank Spot markets list yet; LBank status UNKNOWN and the queue is withheld");
    else if (ctx.lbankCrawl.status !== "COMPLETE") warnings.push(`LBANK_FEED_UNAVAILABLE: no complete LBank Spot markets list (latest attempt ${ctx.lbankCrawl.status}); the queue is withheld`);
    else if (!ctx.lbankCrawl.fresh) warnings.push(`LBANK_FEED_UNAVAILABLE: the LBank Spot markets list from ${ctx.lbankCrawl.finishedAt.toISOString()} is older than ${this.cfg.LBANK_PAIRS_MAX_AGE_DAYS} days; refresh it — the queue is withheld`);
    else if (ctx.lbankCrawl.pairs === 0) warnings.push("EMPTY_VENUE_MAPPING: the LBank crawl returned no pairs");
    const missingDaily = evaluated.filter((r) => r.avg3dReason === REASON.dailyRowMissing).map((r) => r.cmcId);
    if (missingDaily.length) {
      const prev = await this.prisma.scanResult.findMany({ where: { providerId: ctx.batch.providerId, cmcId: { in: missingDaily }, avg3dReason: REASON.dailyRowMissing, crawledAt: { lt: ctx.batch.crawledAt, gte: new Date(ctx.batch.crawledAt.getTime() - 26 * 3_600_000) } }, select: { cmcId: true }, distinct: ["cmcId"] });
      warnings.push(`MISSING_DAILY_DATA: ${missingDaily.length} evaluated assets lack a completed daily row in the 3-day window${prev.length ? ` (${prev.length} also in an earlier batch within 26 h)` : ""}`);
    }
    const stale = rows.filter((r) => r.currentStatus === "STALE").length;
    if (stale) {
      const prevRun = await this.prisma.scanRun.findFirst({ where: { providerId: ctx.batch.providerId, asOf: { lt: ctx.asOf }, status: "succeeded" }, orderBy: { asOf: "desc" }, select: { counts: true } });
      const prevStale = ((prevRun?.counts as { current?: Record<string, number> } | null)?.current?.STALE ?? null) as number | null;
      warnings.push(`STALE_QUOTES: ${stale} current quotes older than ${this.cfg.MAX_QUOTE_AGE_MINUTES} min${prevStale !== null ? ` (previous batch: ${prevStale})` : ""}`);
    }
    const tasks = counts.mappingTasks as number;
    if (tasks) warnings.push(`LBANK_MAPPING_TASKS: ${tasks} ambiguous LBank mappings need a reviewer decision`);
    return { counts, warnings };
  }

  /** After venue refreshes, recompute venue flags for the given rows of the batch. */
  async annotateVenues(batchId: string, cmcIds: number[]): Promise<number> {
    if (!cmcIds.length) return 0;
    const run = await this.prisma.scanRun.findUnique({ where: { batchId } });
    if (!run) return 0;
    const markets = await this.latestAssetMarkets(run.providerId, cmcIds);
    const rows = await this.prisma.scanResult.findMany({ where: { batchId, cmcId: { in: cmcIds } }, select: { id: true, cmcId: true, diagnostics: true } });
    const now = new Date();
    const maxAge = 2 * this.cfg.TIER1_VENUE_REFRESH_HOURS * 3_600_000;
    for (const r of rows) {
      const venue = venueSummary(r.cmcId, markets.get(r.cmcId) ?? null, now, maxAge);
      await this.prisma.scanResult.update({ where: { id: r.id }, data: { venueFlags: venue.flags, diagnostics: { ...((r.diagnostics ?? {}) as object), venue } as never } });
    }
    return rows.length;
  }
}

/** Helper for callers that only need a decimal from a stored string. */
export const decimalOrNull = (s: string | null | undefined) => (s === null || s === undefined ? null : new D(s));

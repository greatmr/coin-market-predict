import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Between, DataSource, In, LessThan, LessThanOrEqual, Not } from 'typeorm';

import { insertRows } from '../../common/entities/insert.js';
import { redact } from '../../common/security/redact.js';
import { addDays, isoDate } from '../../common/utils/dates.js';
import { type DValue, dec, forStorage, sha256 } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { DailyMetric } from '../daily-metrics/entities/daily-metric.entity.js';
import { CmcAsset } from '../ingestion/entities/cmc-asset.entity.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';
import {
  type AssetMarketsView,
  type BatchStatus,
  type ClassResult,
  type Comparison,
  type CurrentResult,
  type DailyInput,
  type EligibilityResult,
  LBANK,
  type LbankCrawlView,
  type LbankResolution,
  type Overrides,
  type PairHistoryView,
  type PassWindow,
  type QueueStatus,
  RANKING_RULESET_VERSION,
  REASON,
  RULES,
  RULESET_VERSION,
  StrategyService,
  type VenueDecisionView,
  type VenuePair,
  type VenueSummary,
  type WindowDays,
  type WindowResult,
  classify,
  compareQueue,
  evaluateEligibility,
  inReviewQueue,
  needsDailyRows,
  notEvaluated,
  rankingScore,
  resolveLbank,
} from '../strategy/index.js';
import { VenueCrawl } from '../venues/entities/venue-crawl.entity.js';
import { VenueDecision } from '../venues/entities/venue-decision.entity.js';
import { VenueMappingTask } from '../venues/entities/venue-mapping-task.entity.js';
import { VenuePairEvent } from '../venues/entities/venue-pair-event.entity.js';

import { ScanResult } from './entities/scan-result.entity.js';
import { ScanRun } from './entities/scan-run.entity.js';

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
  batch: {
    id: string;
    providerId: string;
    slotTime: Date;
    crawledAt: Date;
    status: BatchStatus;
    statusReasons: string[];
    isLive: boolean;
  };
  asOf: Date;
  overrides: Overrides;
  lbankCrawl: {
    id: string;
    status: string;
    finishedAt: Date;
    fresh: boolean;
    pairs: number;
  } | null;
  assets: PreEvaluation[];
  maxQuoteAgeMs: number;
}

export interface ScanOutcome {
  batchId: string;
  status: 'succeeded' | 'failed';
  queueStatus: QueueStatus;
  counts: Record<string, unknown>;
  warnings: string[];
  venueCandidates: Array<{ cmcId: number; slug: string | null }>;
}

/** A `scan_result` row as written: decimals are exact decimal text (rounded only for storage). */
type Persisted<T> = { [K in keyof T]: T[K] extends DValue | null ? string | null : T[K] };
type ScanRow = Omit<Persisted<ScanResult>, 'id' | 'scanRun' | 'provider'>;

const n = (v: { toString(): string } | null | undefined) => dec(v ?? null);

/**
 * Tier 1 scan of one crawl batch (PDF p.9–14, p.16). Every rule comes from the strategy module
 * (`modules/strategy`); this service only loads the stored inputs, applies the rules and persists
 * the results, the queue order, mapping tasks and the run summary.
 */
@Injectable()
export class ScanService {
  private readonly log = new Logger(ScanService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly strategy: StrategyService,
  ) {}

  get maxQuoteAgeMs() {
    return this.strategy.maxQuoteAgeMs;
  }

  async latestBatch(providerId: string) {
    return this.db
      .getRepository(CrawlBatch)
      .findOne({ where: { providerId, status: Not('FAILED') }, order: { slotTime: 'DESC' } });
  }

  /** Inputs of one batch as stored, plus the evaluation that needs no daily rows. */
  async loadContext(batchId: string): Promise<BatchContext> {
    const b = await this.db.getRepository(CrawlBatch).findOneByOrFail({ id: batchId });
    const asOf = b.crawledAt;
    const overrides = this.strategy.loadOverrides();
    const snaps = await this.db.getRepository(MarketSnapshot).find({
      where: { providerId: b.providerId, slotTime: b.slotTime },
      relations: { asset: true },
      select: {
        id: true,
        providerAssetId: true,
        price: true,
        marketCap: true,
        marketCapProvenance: true,
        volumeRolling24h: true,
        observedAt: true,
        collectedAt: true,
        rank: true,
        dateAdded: true,
        tags: true,
        sourceUrl: true,
        asset: { id: true, symbol: true, name: true, assetClass: true, classSource: true },
      },
    });
    const cmcIds = snaps
      .map((s) => Number(s.providerAssetId))
      .filter((x) => Number.isSafeInteger(x));
    const cmc = new Map(
      cmcIds.length
        ? (
            await this.db.getRepository(CmcAsset).find({
              where: { providerId: b.providerId, cmcId: In(cmcIds) },
              select: { providerId: true, cmcId: true, symbol: true, name: true, slug: true },
            })
          ).map((a) => [a.cmcId, a])
        : [],
    );

    // LBank Spot markets list = reference data refreshed every LBANK_PAIRS_REFRESH_DAYS or on demand
    // (D2): the newest COMPLETE list available when the scan runs, stale beyond
    // LBANK_PAIRS_MAX_AGE_DAYS. Without any complete list, the newest attempt explains why.
    const crawls = this.db.getRepository(VenueCrawl);
    const crawlRow =
      (await crawls.findOne({
        where: { providerId: b.providerId, kind: 'lbank_spot_pairs', status: 'COMPLETE' },
        order: { finishedAt: 'DESC' },
      })) ??
      (await crawls.findOne({
        where: { providerId: b.providerId, kind: 'lbank_spot_pairs' },
        order: { finishedAt: 'DESC' },
      }));
    const crawlView: LbankCrawlView | null = crawlRow
      ? {
          id: crawlRow.id,
          status: crawlRow.status,
          finishedAt: crawlRow.finishedAt,
          pairs: crawlRow.pairs ?? [],
        }
      : null;
    const lctx = this.strategy.lbankContext(crawlView, asOf);

    const decisions = new Map<number, VenueDecisionView[]>();
    for (const d of await this.db
      .getRepository(VenueDecision)
      .findBy({ providerId: b.providerId, exchange: LBANK })) {
      decisions.set(d.cmcId, [
        ...(decisions.get(d.cmcId) ?? []),
        {
          id: d.id,
          marketPair: d.marketPair,
          decision: d.decision,
          decidedAt: d.decidedAt,
          reviewer: d.reviewer,
          source: 'review',
        },
      ]);
    }
    const history = new Map<number, { lastAbsentAt: Map<string, Date>; everListed: Set<string> }>();
    if (crawlView) {
      for (const e of await this.db.getRepository(VenuePairEvent).find({
        where: {
          providerId: b.providerId,
          exchange: LBANK,
          at: LessThanOrEqual(crawlView.finishedAt),
        },
        order: { at: 'ASC' },
      })) {
        const h = history.get(e.cmcId) ?? { lastAbsentAt: new Map(), everListed: new Set() };
        if (e.event === 'LISTED') h.everListed.add(e.marketPair);
        else h.lastAbsentAt.set(e.marketPair, e.at);
        history.set(e.cmcId, h);
      }
    }
    const rankCounts = new Map<number, number>();
    for (const s of snaps)
      if (s.rank !== null) rankCounts.set(s.rank, (rankCounts.get(s.rank) ?? 0) + 1);
    const noHistory: PairHistoryView = { lastAbsentAt: new Map(), everListed: new Set() };

    const assets: PreEvaluation[] = [];
    for (const s of snaps) {
      const cmcId = Number(s.providerAssetId);
      if (!Number.isSafeInteger(cmcId) || cmcId <= 0) continue;
      const meta = cmc.get(cmcId);
      const symbol = meta?.symbol ?? s.asset!.symbol;
      const cls = classify({
        tags: s.tags,
        heuristicClass: s.asset!.assetClass,
        heuristicSource: s.asset!.classSource,
        override: overrides.classFor(b.providerId, cmcId),
      });
      const decs = [
        ...(decisions.get(cmcId) ?? []),
        ...overrides.lbankDecisionsFor(b.providerId, cmcId),
      ];
      const lbank = resolveLbank(cmcId, symbol, lctx, decs, history.get(cmcId) ?? noHistory);
      const cap = n(s.marketCap);
      const capProviderReported = s.marketCapProvenance === 'provider_reported';
      const volume24h = n(s.volumeRolling24h);
      const eligibility = evaluateEligibility({
        rank: s.rank,
        rankDuplicate: s.rank !== null && (rankCounts.get(s.rank) ?? 0) > 1,
        capUsd: cap,
        capProviderReported,
        dateAdded: s.dateAdded,
        asOf,
        cls,
        lbank: { status: lbank.status, reason: lbank.reason },
      });
      assets.push({
        cmcId,
        symbol,
        name: meta?.name ?? s.asset!.name,
        slug: meta?.slug ?? null,
        rank: s.rank,
        dateAdded: s.dateAdded,
        tags: s.tags,
        price: n(s.price),
        cap,
        capProviderReported,
        volume24h,
        observedAt: s.observedAt,
        collectedAt: s.collectedAt,
        sourceUrl: s.sourceUrl,
        cls,
        lbank,
        eligibility,
        decisionIds: [...new Set(lbank.pairs.flatMap((p) => p.decisionIds))],
        currentVmc:
          cap && cap.gt(0) && capProviderReported && volume24h && !volume24h.isNegative()
            ? volume24h.div(cap)
            : null,
      });
    }
    return {
      batch: {
        id: b.id,
        providerId: b.providerId,
        slotTime: b.slotTime,
        crawledAt: b.crawledAt,
        status: b.status,
        statusReasons: b.statusReasons,
        isLive: b.isLive,
      },
      asOf,
      overrides,
      lbankCrawl: crawlRow
        ? {
            id: crawlRow.id,
            status: crawlRow.status,
            finishedAt: crawlRow.finishedAt,
            fresh: lctx.fresh,
            pairs: crawlRow.fetchedCount,
          }
        : null,
      assets,
      maxQuoteAgeMs: this.maxQuoteAgeMs,
    };
  }

  /** Assets whose completed daily rows are needed (not excluded), most relevant first. */
  dailyCandidates(ctx: BatchContext): Array<{ cmcId: number; slug: string | null }> {
    const tier = (a: PreEvaluation) =>
      a.lbank.status === 'VERIFIED' ? 0 : a.lbank.status === 'PAIR_LISTED_UNVERIFIED' ? 1 : 2;
    return ctx.assets
      .filter((a) => needsDailyRows(a.eligibility))
      .sort(
        (a, b) =>
          tier(a) - tier(b) ||
          (b.currentVmc && a.currentVmc
            ? b.currentVmc.cmp(a.currentVmc)
            : a.currentVmc
              ? -1
              : b.currentVmc
                ? 1
                : 0) ||
          a.cmcId - b.cmcId,
      )
      .map((a) => ({ cmcId: a.cmcId, slug: a.slug }));
  }

  /** Evaluate and persist every asset of the batch; reprocessing replaces the batch's rows. */
  async scan(batchId: string, extraWarnings: string[] = []): Promise<ScanOutcome> {
    const startedAt = new Date();
    const ctx = await this.loadContext(batchId);
    const { batch, asOf } = ctx;
    const cv = this.strategy.configVersion(ctx.overrides);
    const runs = this.db.getRepository(ScanRun);
    const restarted = await runs
      .createQueryBuilder()
      .update(ScanRun)
      .set({
        status: 'running',
        startedAt,
        finishedAt: null,
        attempts: () => 'attempts + 1',
        rulesetVersion: RULESET_VERSION,
        rankingRulesetVersion: RANKING_RULESET_VERSION,
        configVersion: cv,
        overridesVersion: ctx.overrides.version,
        error: null,
      })
      .where('batch_id = :batchId', { batchId })
      .execute();
    if (!restarted.affected) {
      await runs.insert({
        batchId,
        providerId: batch.providerId,
        isLive: batch.isLive,
        rulesetVersion: RULESET_VERSION,
        rankingRulesetVersion: RANKING_RULESET_VERSION,
        configVersion: cv,
        overridesVersion: ctx.overrides.version,
        startedAt,
        status: 'running',
        asOf,
      });
    }
    try {
      const outcome = await this.evaluateAndPersist(ctx, cv, extraWarnings);
      this.log.log(
        `scan ${batch.slotTime.toISOString()}: ${JSON.stringify({ eligible: outcome.counts.eligible, needsReview: outcome.counts.needsReview, excluded: outcome.counts.excluded, queue: outcome.counts.queue, queueStatus: outcome.queueStatus })}`,
      );
      return outcome;
    } catch (err) {
      await runs.update(
        { batchId },
        { status: 'failed', finishedAt: new Date(), error: redact(err).slice(0, 2000) },
      );
      throw err;
    }
  }

  private async evaluateAndPersist(
    ctx: BatchContext,
    cv: string,
    extraWarnings: string[],
  ): Promise<ScanOutcome> {
    const { batch, asOf } = ctx;
    const computedAt = new Date();
    const evaluated = ctx.assets.filter((a) => needsDailyRows(a.eligibility));
    const daily = await this.dailyInputs(
      batch.providerId,
      evaluated.map((a) => a.cmcId),
      asOf,
    );
    const markets = await this.latestAssetMarkets(
      batch.providerId,
      evaluated.map((a) => a.cmcId),
    );

    // Unrounded sort keys (the stored values are rounded for storage only).
    const rows: Array<ScanRow & { _m3: DValue | null; _strength: DValue | null }> = [];
    for (const a of ctx.assets) {
      const isEvaluated = needsDailyRows(a.eligibility);
      const rowsFor = daily.get(a.cmcId) ?? new Map<string, DailyInput>();
      const currentInput = {
        present: true,
        volume24h: a.volume24h,
        marketCap: a.cap,
        capProviderReported: a.capProviderReported,
        observedAt: a.observedAt,
        collectedAt: a.collectedAt,
        sameObservation: true,
      };
      const ev = this.strategy.evaluateVmc(asOf, rowsFor, currentInput);
      const comparisons: Record<PassWindow, Comparison> = isEvaluated
        ? ev.comparisons
        : notEvaluated();
      const windows = ev.windows;
      const stars = isEvaluated ? ev.stars : 0;
      // Weighted star ranking (weighted_star_v1): from the same comparisons, never a new pass.
      const rank = rankingScore({
        pass3d: comparisons[3].status,
        pass7d: comparisons[7].status,
        pass30d: comparisons[30].status,
        multiple3d: comparisons[3].multiple,
        multiple7d: comparisons[7].multiple,
        multiple30d: comparisons[30].multiple,
      });
      const venue: VenueSummary | null = isEvaluated
        ? this.strategy.venueSummary(a.cmcId, markets.get(a.cmcId) ?? null, computedAt)
        : null;
      const flags = this.flagsFor(a, ev.current, windows, isEvaluated, batch.status);
      const avg = (d: WindowDays) => (isEvaluated ? forStorage(windows[d].mean) : null);
      const avgReason = (d: WindowDays) => (isEvaluated ? windows[d].reason : REASON.notEvaluated);
      const window30 = windows[30];
      const lineage = isEvaluated
        ? {
            asOfDate: isoDate(asOf),
            dates: window30.dates,
            revisionIds: window30.revisionIds.map((x) => (x === null ? null : Number(x))),
            missingDates: window30.missingDates,
            invalidDates: window30.invalidDates,
          }
        : null;
      const inputs = {
        snapshot: [
          a.rank,
          a.cap?.toFixed() ?? null,
          a.capProviderReported,
          a.volume24h?.toFixed() ?? null,
          a.price?.toFixed() ?? null,
          a.observedAt?.toISOString() ?? null,
          a.collectedAt.toISOString(),
          a.dateAdded?.toISOString() ?? null,
          [...a.tags].sort(),
        ],
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
        vmc3dAvg: avg(3),
        vmc7dAvg: avg(7),
        vmc14dAvg: avg(14),
        vmc30dAvg: avg(30),
        avg3dReason: avgReason(3),
        avg7dReason: avgReason(7),
        avg14dReason: avgReason(14),
        avg30dReason: avgReason(30),
        multiple3d: forStorage(comparisons[3].multiple),
        multiple7d: forStorage(comparisons[7].multiple),
        multiple30d: forStorage(comparisons[30].multiple),
        pass3d: comparisons[3].status,
        pass7d: comparisons[7].status,
        pass30d: comparisons[30].status,
        reason3d: comparisons[3].reason,
        reason7d: comparisons[7].reason,
        reason30d: comparisons[30].reason,
        stars,
        eligibilityStatus: a.eligibility.status,
        eligibilityReasons: a.eligibility.reasons,
        assetClass: a.cls.assetClass,
        classSource: a.cls.kind ? `${a.cls.source} (${a.cls.kind})` : a.cls.source,
        lbankStatus: a.lbank.status,
        lbankReason: a.lbank.reason,
        lbankPairs: a.lbank.pairs,
        venueReview: 'PENDING',
        venueFlags: venue?.flags ?? [],
        flags,
        inQueue: false,
        queueOrder: null,
        weightedPassPoints: rank.weightedPassPoints,
        scoreComplete: rank.scoreComplete,
        weightedStrength: forStorage(rank.weightedStrength),
        rankingRulesetVersion: RANKING_RULESET_VERSION,
        diagnostics: isEvaluated
          ? {
              quoteAgeSeconds:
                ev.current.quoteAgeMs === null ? null : Math.round(ev.current.quoteAgeMs / 1000),
              volumeAvg: Object.fromEntries(
                RULES.windows.map((d) => [d, forStorage(ev.diagnostics.volumeAvg[d])]),
              ),
              volumeRatio24h: Object.fromEntries(
                RULES.windows.map((d) => [d, forStorage(ev.diagnostics.volumeRatio24h[d])]),
              ),
              venue,
              classEvidence: a.cls.evidence,
            }
          : {
              quoteAgeSeconds:
                ev.current.quoteAgeMs === null ? null : Math.round(ev.current.quoteAgeMs / 1000),
            },
        dailyWindow: lineage,
        inputsHash: sha256(JSON.stringify(inputs)).slice(0, 32),
        rulesetVersion: RULESET_VERSION,
        configVersion: cv,
        computedAt,
        _m3: comparisons[3].multiple,
        _strength: rank.weightedStrength,
      });
    }

    const queue = rows.filter((r) =>
      inReviewQueue({ eligibilityStatus: r.eligibilityStatus, stars: r.stars }),
    );
    const sortKey = (r: (typeof rows)[number]) => ({
      cmcId: r.cmcId,
      stars: r.stars,
      weightedPassPoints: r.weightedPassPoints!,
      scoreComplete: r.scoreComplete!,
      weightedStrength: r._strength,
      multiple3d: r._m3,
    });
    queue.sort((x, y) => compareQueue(sortKey(x), sortKey(y)));
    queue.forEach((r, i) => {
      r.inQueue = true;
      r.queueOrder = i + 1;
    });
    const lbankUnavailable =
      !ctx.lbankCrawl || ctx.lbankCrawl.status !== 'COMPLETE' || !ctx.lbankCrawl.fresh;
    const queueStatus: QueueStatus =
      batch.status !== 'COMPLETE'
        ? 'WITHHELD_INCOMPLETE_BATCH'
        : lbankUnavailable
          ? 'WITHHELD_LBANK_UNAVAILABLE'
          : queue.length
            ? 'PUBLISHED'
            : 'EMPTY';

    const counts = await this.countsAndWarnings(ctx, rows, queue.length, extraWarnings);
    const tasks = ctx.assets.flatMap((a) => a.lbank.tasks.map((t) => ({ ...t, cmcId: a.cmcId })));
    const persistable = rows.map(({ _m3, _strength, ...r }) => r);
    await this.db.transaction(async (m) => {
      await m.getRepository(ScanResult).delete({ batchId: batch.id });
      await insertRows(m, ScanResult, persistable as never);
      for (const t of tasks) {
        await m
          .createQueryBuilder()
          .insert()
          .into(VenueMappingTask)
          .values({
            providerId: batch.providerId,
            cmcId: t.cmcId,
            exchange: LBANK,
            marketPair: t.marketPair,
            kind: t.kind,
            evidence: t.evidence as never,
            status: 'OPEN',
            firstSeenBatchId: batch.id,
            lastSeenBatchId: batch.id,
          })
          .orUpdate(
            ['evidence', 'last_seen_batch_id'],
            ['provider_id', 'cmc_id', 'exchange', 'market_pair', 'kind'],
          )
          .updateEntity(false)
          .execute();
      }
      // A task whose mapping is no longer ambiguous for an asset of this batch (decision recorded,
      // pair gone) is resolved; tasks of assets outside the batch are left as they are.
      const tasksRepo = m.getRepository(VenueMappingTask);
      const assetIds = ctx.assets.map((a) => a.cmcId);
      const open = assetIds.length
        ? await tasksRepo.find({
            where: { providerId: batch.providerId, status: 'OPEN', cmcId: In(assetIds) },
            select: { id: true, cmcId: true, marketPair: true, kind: true },
          })
        : [];
      const live = new Set(tasks.map((t) => `${t.cmcId}|${t.marketPair}|${t.kind}`));
      const resolved = open
        .filter((t) => !live.has(`${t.cmcId}|${t.marketPair}|${t.kind}`))
        .map((t) => t.id);
      if (resolved.length)
        await tasksRepo.update(
          { id: In(resolved) },
          { status: 'RESOLVED', resolvedAt: new Date() },
        );
      await m.getRepository(ScanRun).update(
        { batchId: batch.id },
        {
          status: 'succeeded',
          finishedAt: new Date(),
          queueStatus,
          counts: counts.counts as never,
          warnings: counts.warnings,
          lbankCrawlId: ctx.lbankCrawl?.id ?? null,
        },
      );
    });
    const venueCandidates = rows
      .filter((r) => r.inQueue || (r.eligibilityStatus === 'NEEDS_REVIEW' && r.stars > 0))
      .sort(
        (x, y) =>
          (x.queueOrder ?? 1e9) - (y.queueOrder ?? 1e9) || y.stars - x.stars || x.cmcId - y.cmcId,
      )
      .map((r) => ({ cmcId: r.cmcId, slug: r.slug ?? null }));
    return {
      batchId: batch.id,
      status: 'succeeded',
      queueStatus,
      counts: counts.counts,
      warnings: counts.warnings,
      venueCandidates,
    };
  }

  private flagsFor(
    a: PreEvaluation,
    current: CurrentResult,
    windows: Record<WindowDays, WindowResult>,
    evaluated: boolean,
    batchStatus: BatchStatus,
  ): string[] {
    const f: string[] = [];
    if (batchStatus !== 'COMPLETE') f.push('BATCH_INCOMPLETE');
    if (current.status !== 'OK') f.push(`CURRENT_${current.status}`);
    if (!a.capProviderReported && a.cap) f.push('CAP_NOT_PROVIDER_REPORTED');
    if (evaluated && windows[30].missingDates.length)
      f.push(`DAILY_MISSING:${windows[30].missingDates.length}`);
    if (evaluated && windows[30].invalidDates.length)
      f.push(`DAILY_INVALID:${windows[30].invalidDates.length}`);
    if (a.lbank.status === 'PAIR_LISTED_UNVERIFIED') f.push('LBANK_PAIR_UNVERIFIED');
    if (a.lbank.tasks.length) f.push('LBANK_MAPPING_TASK');
    if (a.cls.source.startsWith('override')) f.push('CLASS_OVERRIDE');
    return f;
  }

  /** Effective daily rows for T−lookback … T−1 keyed by asset and date. */
  private async dailyInputs(
    providerId: string,
    cmcIds: number[],
    asOf: Date,
  ): Promise<Map<number, Map<string, DailyInput>>> {
    const out = new Map<number, Map<string, DailyInput>>();
    if (!cmcIds.length) return out;
    const today = isoDate(asOf);
    const from = addDays(
      today,
      -Math.max(this.cfg.TIER1_DAILY_LOOKBACK_DAYS, RULES.requiredDailyRows),
    );
    const to = addDays(today, -1);
    for (let i = 0; i < cmcIds.length; i += 2000) {
      const rows = await this.db.getRepository(DailyMetric).find({
        where: { providerId, cmcId: In(cmcIds.slice(i, i + 2000)), dateUtc: Between(from, to) },
        select: {
          providerId: true,
          cmcId: true,
          dateUtc: true,
          volumeUsd: true,
          marketCapUsd: true,
          valid: true,
          invalidReasons: true,
          revisionId: true,
          closeUsd: true,
        },
      });
      for (const r of rows) {
        const m = out.get(r.cmcId) ?? new Map<string, DailyInput>();
        m.set(r.dateUtc, {
          dateUtc: r.dateUtc,
          volume: n(r.volumeUsd),
          marketCap: n(r.marketCapUsd),
          valid: r.valid,
          invalidReasons: r.invalidReasons,
          revisionId: String(r.revisionId),
          close: n(r.closeUsd),
        });
        out.set(r.cmcId, m);
      }
    }
    return out;
  }

  private async latestAssetMarkets(
    providerId: string,
    cmcIds: number[],
  ): Promise<Map<number, AssetMarketsView>> {
    if (!cmcIds.length) return new Map();
    const rows = (await this.db.query(
      `SELECT DISTINCT ON (cmc_id) id, cmc_id AS "cmcId", status, finished_at AS "finishedAt", expected_count AS "expectedCount", fetched_count AS "fetchedCount", pairs
         FROM venue_crawl WHERE provider_id = $1 AND kind = 'asset_markets' AND cmc_id = ANY($2::int[])
        ORDER BY cmc_id, finished_at DESC`,
      [providerId, cmcIds],
    )) as Array<{
      id: string;
      cmcId: number;
      status: AssetMarketsView['status'];
      finishedAt: Date;
      expectedCount: number | null;
      fetchedCount: number;
      pairs: unknown;
    }>;
    return new Map(
      rows.map((r) => [
        r.cmcId,
        {
          id: r.id,
          status: r.status,
          finishedAt: r.finishedAt,
          expectedCount: r.expectedCount,
          fetchedCount: r.fetchedCount,
          pairs: (r.pairs ?? []) as VenuePair[],
        },
      ]),
    );
  }

  /** Run counts and observability warnings (PDF p.18). Counts and comparisons only; no thresholds. */
  private async countsAndWarnings(
    ctx: BatchContext,
    rows: ScanRow[],
    queue: number,
    extra: string[],
  ) {
    const tally = (xs: string[]) =>
      xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
    const evaluated = rows.filter((r) => r.eligibilityStatus !== 'EXCLUDED');
    const counts: Record<string, unknown> = {
      assets: rows.length,
      eligible: rows.filter((r) => r.eligibilityStatus === 'ELIGIBLE').length,
      needsReview: rows.filter((r) => r.eligibilityStatus === 'NEEDS_REVIEW').length,
      excluded: rows.filter((r) => r.eligibilityStatus === 'EXCLUDED').length,
      queue,
      evaluated: evaluated.length,
      stars: tally(evaluated.map((r) => String(r.stars))),
      pass: Object.fromEntries(
        (['pass3d', 'pass7d', 'pass30d'] as const).map((k) => [
          k,
          tally(evaluated.map((r) => r[k])),
        ]),
      ),
      notAvailable: Object.fromEntries(
        (['reason3d', 'reason7d', 'reason30d'] as const).map((k) => [
          k,
          tally(evaluated.map((r) => r[k]).filter((x: string | null): x is string => !!x)),
        ]),
      ),
      current: tally(rows.map((r) => r.currentStatus)),
      lbank: tally(rows.map((r) => r.lbankStatus)),
      reasons: tally(rows.flatMap((r) => r.eligibilityReasons.map((x) => x.split(':')[0]!))),
      batchStatus: ctx.batch.status,
      lbankCrawl: ctx.lbankCrawl,
      overridesVersion: ctx.overrides.version,
      mappingTasks: ctx.assets.reduce((s, a) => s + a.lbank.tasks.length, 0),
    };
    const warnings = [...extra];
    if (ctx.batch.status !== 'COMPLETE')
      warnings.push(
        `INCOMPLETE_UNIVERSE: batch ${ctx.batch.status} (${ctx.batch.statusReasons.join(', ')}); the Review Queue is not complete`,
      );
    if (!ctx.lbankCrawl)
      warnings.push(
        'LBANK_FEED_MISSING: no LBank Spot markets list yet; LBank status UNKNOWN and the queue is withheld',
      );
    else if (ctx.lbankCrawl.status !== 'COMPLETE')
      warnings.push(
        `LBANK_FEED_UNAVAILABLE: no complete LBank Spot markets list (latest attempt ${ctx.lbankCrawl.status}); the queue is withheld`,
      );
    else if (!ctx.lbankCrawl.fresh)
      warnings.push(
        `LBANK_FEED_UNAVAILABLE: the LBank Spot markets list from ${ctx.lbankCrawl.finishedAt.toISOString()} is older than ${this.cfg.LBANK_PAIRS_MAX_AGE_DAYS} days; refresh it — the queue is withheld`,
      );
    else if (ctx.lbankCrawl.pairs === 0)
      warnings.push('EMPTY_VENUE_MAPPING: the LBank crawl returned no pairs');
    const missingDaily = evaluated
      .filter((r) => r.avg3dReason === REASON.dailyRowMissing)
      .map((r) => r.cmcId);
    if (missingDaily.length) {
      const prev = (await this.db
        .getRepository(ScanResult)
        .createQueryBuilder('r')
        .select('DISTINCT r.cmc_id', 'cmcId')
        .where('r.provider_id = :providerId', { providerId: ctx.batch.providerId })
        .andWhere('r.cmc_id = ANY(:ids)', { ids: missingDaily })
        .andWhere('r.avg_3d_reason = :reason', { reason: REASON.dailyRowMissing })
        .andWhere('r.crawled_at < :to AND r.crawled_at >= :from', {
          to: ctx.batch.crawledAt,
          from: new Date(ctx.batch.crawledAt.getTime() - 26 * 3_600_000),
        })
        .getRawMany()) as Array<{ cmcId: number }>;
      warnings.push(
        `MISSING_DAILY_DATA: ${missingDaily.length} evaluated assets lack a completed daily row in the 3-day window${prev.length ? ` (${prev.length} also in an earlier batch within 26 h)` : ''}`,
      );
    }
    const stale = rows.filter((r) => r.currentStatus === 'STALE').length;
    if (stale) {
      const prevRun = await this.db.getRepository(ScanRun).findOne({
        where: {
          providerId: ctx.batch.providerId,
          asOf: LessThan(ctx.asOf),
          status: 'succeeded',
        },
        order: { asOf: 'DESC' },
        select: { batchId: true, counts: true },
      });
      const prevStale = ((prevRun?.counts as { current?: Record<string, number> } | null)?.current
        ?.STALE ?? null) as number | null;
      warnings.push(
        `STALE_QUOTES: ${stale} current quotes older than ${this.cfg.MAX_QUOTE_AGE_MINUTES} min${prevStale !== null ? ` (previous batch: ${prevStale})` : ''}`,
      );
    }
    const tasks = counts.mappingTasks as number;
    if (tasks)
      warnings.push(
        `LBANK_MAPPING_TASKS: ${tasks} ambiguous LBank mappings need a reviewer decision`,
      );
    return { counts, warnings };
  }

  /** After venue refreshes, recompute venue flags for the given rows of the batch. */
  async annotateVenues(batchId: string, cmcIds: number[]): Promise<number> {
    if (!cmcIds.length) return 0;
    const run = await this.db.getRepository(ScanRun).findOneBy({ batchId });
    if (!run) return 0;
    const markets = await this.latestAssetMarkets(run.providerId, cmcIds);
    const results = this.db.getRepository(ScanResult);
    const rows = await results.find({
      where: { batchId, cmcId: In(cmcIds) },
      select: { id: true, cmcId: true, diagnostics: true },
    });
    const now = new Date();
    for (const r of rows) {
      const venue = this.strategy.venueSummary(r.cmcId, markets.get(r.cmcId) ?? null, now);
      await results.update(
        { id: r.id },
        { venueFlags: venue.flags, diagnostics: { ...(r.diagnostics ?? {}), venue } as never },
      );
    }
    return rows.length;
  }
}

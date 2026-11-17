import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, type DataSource, In, MoreThanOrEqual } from 'typeorm';

import { DAY_MS, parseIsoDate } from '../../common/utils/dates.js';
import { D, type DValue, dec, forStorage } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../sources/entities/provider.entity.js';
import {
  type Availability,
  type BithumbFilter,
  EXCHANGE_LIST_KEYS,
  type ExchangeListKey,
  type ListView,
  type MarketFilter,
  availability,
  bithumbFilterSql,
  marketFilterSql,
} from '../venues/exchange-lists.js';
import { VenuesService } from '../venues/venues.service.js';

import {
  type CohortGroup,
  type CoinAverageReturn,
  type Stats,
  cohortReport,
  coinAverageReturns,
  overlapMap,
} from './cohort.js';
import { ForwardEvent } from './entities/forward-event.entity.js';
import { ForwardHigh } from './entities/forward-high.entity.js';
import { ForwardOutcome } from './entities/forward-outcome.entity.js';
import { ForwardTestWatchlist } from './entities/forward-test-watchlist.entity.js';
import { ForwardTriggerRejection } from './entities/forward-trigger-rejection.entity.js';
import { ForwardTriggerRun } from './entities/forward-trigger-run.entity.js';
import { ForwardUpdateRun } from './entities/forward-update-run.entity.js';
import { type WindowProgress, peakReturnPct, windowProgress } from './forward-rules.js';
import { storedWindow } from './forward-update.service.js';
import {
  ACTIVE_EVENT_STATUSES,
  type EventResultFilter,
  type EventSortKey,
  FORWARD_EVENT_STATUSES,
  FORWARD_REASON,
  FORWARD_RULES_VERSION,
  type ForwardCheckStatus,
  type ForwardEventStatus,
  HORIZON_HOURS,
  type HighEligibility,
  type PeakKind,
} from './forward.constants.js';

export type EventView = 'active' | 'final' | 'incomplete' | 'all';

export const VIEW_STATUSES: Record<EventView, readonly ForwardEventStatus[]> = {
  active: ACTIVE_EVENT_STATUSES,
  final: ['FINAL'],
  incomplete: ['INCOMPLETE'],
  all: FORWARD_EVENT_STATUSES,
};

export const FORWARD_NOTICE =
  'Observed maximum future High from the CMC detection price: a hypothetical upside, not an executable trade, not a close-to-close return and not realized P/L (no fees, spread or slippage). No pump threshold is defined; read the actual percentages.';

/** SQL of each sort key: the detection snapshot or the latest outcome (`o`). */
const SORT_SQL: Record<EventSortKey, string> = {
  detected: 'e.detected_at',
  return: 'o.peak_return_pct',
  stars: 'e.star_count',
  points: 'e.weighted_pass_points',
  multiple3d: 'e.multiple_3d',
  multiple7d: 'e.multiple_7d',
  multiple30d: 'e.multiple_30d',
};

/** Signal-day flags of an unconfirmed day-0 High (DAY0_UNRESOLVED while open, INCOMPLETE_DAY0 after). */
const DAY0_UNCONFIRMED_FLAGS: readonly string[] = [
  FORWARD_REASON.day0Unresolved,
  FORWARD_REASON.incompleteDay0,
];

export const DAY_DEFINITION =
  'A day is a UTC calendar day (00:00:00.000–23:59:59.999 UTC). Day 0 is the UTC date of identification; day 7 is the UTC date of identification + 168 h, included to its end.';

/** Exact decimal text (30 dp at most, as stored), never a float. */
const s = (v: DValue | null | undefined) => (v === null || v === undefined ? null : forStorage(v));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A coin's Average Return over all its stored events (cohort.ts `coinAverageReturns`). */
export interface CoinAverageReturnJson {
  /** Every stored event of the coin (CMC id), any status and star count. */
  events: number;
  /** Events with a numeric Return; the others are left out, never counted as 0 %. */
  withReturn: number;
  /** Of those, Returns shown as lower bounds (≥): when > 0 the average is a lower bound too. */
  lowerBounds: number;
  /** Arithmetic mean of those Returns in percent (exact decimal text); null when there is none. */
  averagePct: string | null;
}

const coinAverageJson = (c: CoinAverageReturn | undefined): CoinAverageReturnJson => ({
  events: c?.events ?? 0,
  withReturn: c?.withReturn ?? 0,
  lowerBounds: c?.lowerBounds ?? 0,
  averagePct: s(c?.average),
});

/** Whether one exchange list has the coin now (ADR-0007): YES, NO, or UNKNOWN with the reason. */
export interface ListingJson {
  status: Availability['status'];
  pairs: string[];
  reason: string | null;
  /** Fetch time of the list that answered (null when no list could). */
  listFetchedAt: string | null;
}

const listingJson = (view: ListView, cmcId: number, symbol: string): ListingJson => {
  const a = availability(view, cmcId, symbol);
  return {
    status: a.status,
    pairs: [...a.pairs],
    reason: a.reason,
    listFetchedAt: view.status === 'VERIFIED' ? iso(view.fetchedAt) : null,
  };
};

export const listStatusJson = (v: ListView) => ({
  key: v.key,
  label: v.label,
  status: v.status,
  fetchedAt: iso(v.fetchedAt),
  staleAt: iso(v.staleAt),
  pairs: v.pairs,
  lastAttempt: v.lastAttempt
    ? {
        at: v.lastAttempt.at.toISOString(),
        status: v.lastAttempt.status,
        error: v.lastAttempt.error,
      }
    : null,
});

export interface ForwardEventRow {
  eventId: string;
  cmcId: number;
  symbol: string;
  name: string;
  slug: string | null;
  isLive: boolean;
  detectedAt: string;
  detectedUtcDate: string;
  detectionHourUtc: number;
  starCount: number;
  referencePriceUsd: string;
  sourceUpdatedAt: string;
  sourceBatchId: string;
  rank: number | null;
  pass3d: string;
  pass7d: string;
  pass30d: string;
  multiple3d: string | null;
  multiple7d: string | null;
  multiple30d: string | null;
  /** Detection-time ranking (weighted star ranking): pattern, points, completeness, strength. */
  passPattern: string;
  weightedPassPoints: number | null;
  scoreComplete: boolean | null;
  weightedStrength: string | null;
  rankingRulesetVersion: string | null;
  currentVmc: string | null;
  lbankPairs: string[];
  rulesetVersion: string;
  deadline168h: string;
  evaluationEnd: string;
  effectiveHorizonHours: string;
  status: ForwardEventStatus;
  qualityFlags: string[];
  resultVersion: number;
  lastUpdateAt: string | null;
  finalizedAt: string | null;
  outcome: {
    resultVersion: number;
    revisionReason: string;
    rulesVersion: string;
    coverageStatus: string;
    peakKind: string;
    peakHighUsd: string | null;
    peakAt: string | null;
    peakDate: string | null;
    peakTimePrecision: string | null;
    peakPeriodStart: string | null;
    peakPeriodEnd: string | null;
    peakReturnPct: string | null;
    extensionPeakFlag: string | null;
    day0State: string;
    expectedDays: number;
    completedDays: number;
    coveredDays: number;
    missingDates: string[];
    invalidDates: string[];
    reasons: string[];
    computedAt: string;
    finalizedAt: string | null;
  } | null;
  assetEventCount: number;
  overlappingEventIds: string[];
  /** Average Return of this event's coin over all its stored events (not only this page or view). */
  coinAverageReturn: CoinAverageReturnJson;
  /**
   * The coin's listings now (latest lists, not at identification): LBank Spot, LBank Futures and
   * Bithumb Spot, each from that exchange's own markets list, by CMC id (ADR-0007).
   */
  exchanges: Record<ExchangeListKey, ListingJson>;
  /** The latest High check of this event (NOT_CHECKED before the first one). */
  check: {
    status: ForwardCheckStatus | 'NOT_CHECKED';
    /** Last attempt, successful or not. */
    lastCheckAt: string | null;
    /** Last successful check (the outcome was evaluated). */
    lastSuccessAt: string | null;
    /** Every closed included UTC day up to this date has a usable daily High. */
    checkedThrough: string | null;
    note: string | null;
  };
  /** Position in the window at read time; `checkedDays` = days 0 … checkedThrough. */
  window: WindowProgress & { checkedDays: number };
  /**
   * The signal-day (day 0) daily High as stored: it counts only when its source time is at or after
   * identification (DAY0_POST_SIGNAL); DAY0_UNPROVEN is shown apart and never enters a result.
   */
  day0: {
    highUsd: string | null;
    timeHigh: string | null;
    eligibility: HighEligibility;
    reason: string | null;
    /** 100 × (day-0 High / reference price − 1): what it would be if it were post-signal. */
    changePct: string | null;
  } | null;
}

function outcomeJson(o: ForwardOutcome): NonNullable<ForwardEventRow['outcome']> {
  return {
    resultVersion: o.resultVersion,
    revisionReason: o.revisionReason,
    rulesVersion: o.rulesVersion,
    coverageStatus: o.coverageStatus,
    peakKind: o.peakKind,
    peakHighUsd: o.peakHighUsd?.toFixed() ?? null,
    peakAt: iso(o.peakAt),
    peakDate: o.peakDate,
    peakTimePrecision: o.peakTimePrecision,
    peakPeriodStart: iso(o.peakPeriodStart),
    peakPeriodEnd: iso(o.peakPeriodEnd),
    peakReturnPct: s(o.peakReturnPct),
    extensionPeakFlag: o.extensionPeakFlag,
    day0State: o.day0State,
    expectedDays: o.expectedDays,
    completedDays: o.completedDays,
    coveredDays: o.coveredDays,
    missingDates: o.missingDates,
    invalidDates: o.invalidDates,
    reasons: o.reasons,
    computedAt: o.computedAt.toISOString(),
    finalizedAt: iso(o.finalizedAt),
  };
}

function statsJson(x: Stats) {
  return {
    n: x.n,
    mean: s(x.mean),
    median: s(x.median),
    p25: s(x.p25),
    p75: s(x.p75),
    min: s(x.min),
    max: s(x.max),
  };
}

export function cohortGroupJson(g: CohortGroup) {
  return {
    ...g,
    finalReturns: statsJson(g.finalReturns),
    activeReturns: statsJson(g.activeReturns),
    horizonHours: { ...statsJson(g.horizonHours), bins: g.horizonHours.bins },
  };
}

/**
 * Read-only forward-test queries shared by the dashboard API, MCP, the CLI and the export. All
 * money and percentage values are exact decimal strings; nothing here writes.
 */
@Injectable()
export class ForwardReadService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly venues: VenuesService,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  /** Event rows with their latest outcome, newest detection first. */
  async events(q: {
    view: EventView;
    status?: ForwardEventStatus;
    result?: EventResultFilter;
    sort?: EventSortKey;
    dir?: 'asc' | 'desc';
    stars?: number;
    /** LBank Spot / Futures listing of the coin now (exchange-lists.ts `matchesMarket`). */
    market?: MarketFilter;
    /** Bithumb listing of the coin now. */
    bithumb?: BithumbFilter;
    search?: string;
    limit: number;
    offset: number;
  }): Promise<{ total: number; offset: number; rows: ForwardEventRow[] }> {
    const lists = await this.venues.exchangeListViews(this.providerId);
    const qb = this.db
      .getRepository(ForwardEvent)
      .createQueryBuilder('e')
      .leftJoin(ForwardOutcome, 'o', 'o.event_id = e.id AND o.result_version = e.result_version')
      .where('e.provider_id = :providerId', { providerId: this.providerId })
      .andWhere('e.status IN (:...statuses)', {
        statuses: q.status ? [q.status] : VIEW_STATUSES[q.view],
      });
    if (q.stars) qb.andWhere('e.star_count = :stars', { stars: q.stars });
    if (q.result === 'NOT_CHECKED') qb.andWhere('e.last_check_status IS NULL');
    else if (q.result === 'CONFIRMED') qb.andWhere('o.peak_high_usd IS NOT NULL');
    else if (q.result === 'DAY0_UNCONFIRMED')
      qb.andWhere('e.quality_flags && CAST(:day0Flags AS text[])', {
        day0Flags: DAY0_UNCONFIRMED_FLAGS,
      });
    else if (q.result) qb.andWhere('e.last_check_status = :result', { result: q.result });
    if (q.market) {
      const m = marketFilterSql(q.market, lists.lbankSpot, lists.lbankFutures);
      qb.andWhere(m.sql, m.params);
    }
    if (q.bithumb) {
      const b = bithumbFilterSql(q.bithumb, lists.bithumb);
      qb.andWhere(b.sql, b.params);
    }
    const search = q.search?.trim();
    if (search) {
      const id = /^\d{1,10}$/.test(search) ? Number(search) : null;
      qb.andWhere(
        new Brackets((w) => {
          w.where('e.symbol ILIKE :term', {
            term: `%${search.replace(/[\\%_]/g, '\\$&')}%`,
          }).orWhere('e.name ILIKE :term');
          if (id !== null && id <= 2_147_483_647) w.orWhere('e.cmc_id = :id', { id });
        }),
      );
    }
    const primary = SORT_SQL[q.sort ?? 'detected'];
    qb.orderBy(primary, q.dir === 'asc' ? 'ASC' : 'DESC', 'NULLS LAST');
    // Order keys are a map in TypeORM: a tie-breaker on the same column would replace the primary.
    for (const tie of ['e.detected_at', 'e.star_count'])
      if (tie !== primary) qb.addOrderBy(tie, 'DESC');
    const [events, total] = await qb
      .addOrderBy('e.id', 'ASC')
      .offset(q.offset)
      .limit(q.limit)
      .getManyAndCount();
    return { total, offset: q.offset, rows: await this.rows(events, lists) };
  }

  /** Every event of the provider (exports), oldest first. */
  async allEvents(): Promise<ForwardEventRow[]> {
    const events = await this.db.getRepository(ForwardEvent).find({
      where: { providerId: this.providerId },
      order: { detectedAt: 'ASC', starCount: 'ASC' },
    });
    return this.rows(events);
  }

  /** Every stored event of these coins with its latest Return, for overlaps and coin averages. */
  private async coinEvents(cmcIds: readonly number[]) {
    const rows = (await this.db.query(
      `SELECT e.id AS "eventId", e.cmc_id AS "cmcId", e.detected_at AS "detectedAt",
              e.evaluation_end AS "evaluationEnd", o.peak_kind AS "peakKind",
              o.peak_return_pct::text AS "ret"
         FROM forward_event e
         LEFT JOIN forward_outcome o ON o.event_id = e.id AND o.result_version = e.result_version
        WHERE e.provider_id = $1 AND e.cmc_id = ANY($2::int[])`,
      [this.providerId, [...new Set(cmcIds)]],
    )) as Array<{
      eventId: string;
      cmcId: number;
      detectedAt: Date;
      evaluationEnd: Date;
      peakKind: PeakKind | null;
      ret: string | null;
    }>;
    return rows.map((r) => ({ ...r, peakReturnPct: r.ret === null ? null : new D(r.ret) }));
  }

  private async rows(
    events: ForwardEvent[],
    lists?: Record<ExchangeListKey, ListView>,
    now = new Date(),
  ): Promise<ForwardEventRow[]> {
    if (!events.length) return [];
    const views = lists ?? (await this.venues.exchangeListViews(this.providerId, now));
    const day0 = new Map(
      (
        (await this.db.query(
          `SELECT h.event_id AS "eventId", h.high_usd::text AS "high", h.time_high AS "timeHigh",
                  h.eligibility, h.reason
             FROM forward_high h
             JOIN forward_event e ON e.id = h.event_id AND h.date_utc = e.detected_utc_date
            WHERE h.is_current AND h.event_id = ANY($1::uuid[])`,
          [events.map((e) => e.id)],
        )) as Array<{
          eventId: string;
          high: string | null;
          timeHigh: Date | null;
          eligibility: HighEligibility;
          reason: string | null;
        }>
      ).map((h) => [h.eventId, h]),
    );
    // Only each event's latest version (older versions stay in the table for audit).
    const outcomes = new Map(
      (
        await this.db
          .getRepository(ForwardOutcome)
          .createQueryBuilder('o')
          .innerJoin(ForwardEvent, 'e', 'e.id = o.event_id AND e.result_version = o.result_version')
          .where('o.event_id = ANY(:ids)', { ids: events.map((e) => e.id) })
          .getMany()
      ).map((o) => [o.eventId, o]),
    );
    // Correlation markers and coin averages need every event of the same assets, not just this page.
    const siblings = await this.coinEvents(events.map((e) => e.cmcId));
    const overlaps = overlapMap(siblings);
    const coins = coinAverageReturns(siblings);
    return events.map((e) => {
      const o = outcomes.get(e.id);
      const d0 = day0.get(e.id);
      const d0High = d0 ? dec(d0.high) : null;
      const checkedDays = e.checkedThrough
        ? Math.round(
            (parseIsoDate(e.checkedThrough).getTime() - parseIsoDate(e.detectedUtcDate).getTime()) /
              DAY_MS,
          ) + 1
        : 0;
      return {
        eventId: e.id,
        cmcId: e.cmcId,
        symbol: e.symbol,
        name: e.name,
        slug: e.slug,
        isLive: e.isLive,
        detectedAt: e.detectedAt.toISOString(),
        detectedUtcDate: e.detectedUtcDate,
        detectionHourUtc: e.detectedAt.getUTCHours(),
        starCount: e.starCount,
        referencePriceUsd: e.snapshotPriceUsd.toFixed(),
        sourceUpdatedAt: e.sourceUpdatedAt.toISOString(),
        sourceBatchId: e.sourceBatchId,
        rank: e.rank,
        pass3d: e.pass3d,
        pass7d: e.pass7d,
        pass30d: e.pass30d,
        multiple3d: s(e.multiple3d),
        multiple7d: s(e.multiple7d),
        multiple30d: s(e.multiple30d),
        passPattern: `${e.pass3d}/${e.pass7d}/${e.pass30d}`,
        weightedPassPoints: e.weightedPassPoints,
        scoreComplete: e.scoreComplete,
        weightedStrength: s(e.weightedStrength),
        rankingRulesetVersion: e.rankingRulesetVersion,
        currentVmc: s(e.currentVmc),
        lbankPairs: (e.lbankPairs ?? []).map((p) => p.marketPair),
        rulesetVersion: e.rulesetVersion,
        deadline168h: e.deadline168h.toISOString(),
        evaluationEnd: e.evaluationEnd.toISOString(),
        effectiveHorizonHours: s(e.effectiveHorizonHours)!,
        status: e.status,
        qualityFlags: e.qualityFlags,
        resultVersion: e.resultVersion,
        lastUpdateAt: iso(e.lastUpdateAt),
        finalizedAt: iso(e.finalizedAt),
        outcome: o ? outcomeJson(o) : null,
        assetEventCount: coins.get(e.cmcId)?.events ?? 1,
        overlappingEventIds: overlaps.get(e.id) ?? [],
        coinAverageReturn: coinAverageJson(coins.get(e.cmcId)),
        exchanges: {
          lbankSpot: listingJson(views.lbankSpot, e.cmcId, e.symbol),
          lbankFutures: listingJson(views.lbankFutures, e.cmcId, e.symbol),
          bithumb: listingJson(views.bithumb, e.cmcId, e.symbol),
        },
        check: {
          status: e.lastCheckStatus ?? 'NOT_CHECKED',
          lastCheckAt: iso(e.lastCheckAt),
          lastSuccessAt: iso(e.lastUpdateAt),
          checkedThrough: e.checkedThrough,
          note: e.lastCheckNote,
        },
        window: { ...windowProgress(storedWindow(e), now), checkedDays },
        day0: d0
          ? {
              highUsd: d0High?.toFixed() ?? null,
              timeHigh: iso(d0.timeHigh),
              eligibility: d0.eligibility,
              reason: d0.reason,
              changePct:
                d0High && d0High.isFinite() && d0High.gt(0)
                  ? s(peakReturnPct(d0High, e.snapshotPriceUsd))
                  : null,
            }
          : null,
      };
    });
  }

  /**
   * The same coin's other events (any star count) whose windows [detected_at, evaluation_end] share
   * at least one moment with this one's: correlated observations of one price path.
   */
  async overlaps(id: string) {
    const repo = this.db.getRepository(ForwardEvent);
    const e = await repo.findOneBy({ id, providerId: this.providerId });
    if (!e) return null;
    const others = await repo
      .createQueryBuilder('x')
      .where('x.provider_id = :p AND x.cmc_id = :c AND x.id <> :id', {
        p: this.providerId,
        c: e.cmcId,
        id: e.id,
      })
      .andWhere('x.detected_at <= :end AND x.evaluation_end >= :start', {
        end: e.evaluationEnd,
        start: e.detectedAt,
      })
      .orderBy('x.detected_at', 'ASC')
      .addOrderBy('x.star_count', 'ASC')
      .getMany();
    const outcomes = new Map(
      others.length
        ? (
            await this.db
              .getRepository(ForwardOutcome)
              .createQueryBuilder('o')
              .innerJoin(
                ForwardEvent,
                'x',
                'x.id = o.event_id AND x.result_version = o.result_version',
              )
              .where('o.event_id = ANY(:ids)', { ids: others.map((x) => x.id) })
              .getMany()
          ).map((o) => [o.eventId, o])
        : [],
    );
    const summary = (x: ForwardEvent) => ({
      eventId: x.id,
      symbol: x.symbol,
      name: x.name,
      starCount: x.starCount,
      detectedAt: x.detectedAt.toISOString(),
      detectedUtcDate: x.detectedUtcDate,
      referencePriceUsd: x.snapshotPriceUsd.toFixed(),
      evaluationEnd: x.evaluationEnd.toISOString(),
      status: x.status,
    });
    // The coin's Average Return covers every stored event of the coin, overlapping or not.
    const coin = coinAverageReturns(await this.coinEvents([e.cmcId])).get(e.cmcId);
    return {
      event: summary(e),
      coin: { cmcId: e.cmcId, ...coinAverageJson(coin) },
      rule: 'Same CMC id, any star count, and windows from identification to the end of the window that share at least one moment. Each is its own event (one per coin, UTC day and star count), but they follow one price path, so they are correlated, not independent.',
      overlaps: others.map((x) => {
        const o = outcomes.get(x.id);
        const start = Math.max(x.detectedAt.getTime(), e.detectedAt.getTime());
        const end = Math.min(x.evaluationEnd.getTime(), e.evaluationEnd.getTime());
        return {
          ...summary(x),
          relation:
            x.detectedUtcDate === e.detectedUtcDate
              ? ('same_utc_day' as const)
              : x.detectedAt < e.detectedAt
                ? ('earlier' as const)
                : ('later' as const),
          overlapStart: new Date(start).toISOString(),
          overlapEnd: new Date(end).toISOString(),
          overlapHours: s(new D(end + 1 - start).div(3_600_000)),
          peakReturnPct: o ? s(o.peakReturnPct) : null,
          peakKind: o?.peakKind ?? null,
        };
      }),
    };
  }

  /** One event with every High observation (superseded ones too) and every outcome version. */
  async event(id: string) {
    const e = await this.db
      .getRepository(ForwardEvent)
      .findOneBy({ id, providerId: this.providerId });
    if (!e) return null;
    const [row] = await this.rows([e]);
    const [highs, outcomes, trigger] = await Promise.all([
      this.db
        .getRepository(ForwardHigh)
        .find({ where: { eventId: id }, order: { periodStart: 'ASC', id: 'ASC' } }),
      this.db
        .getRepository(ForwardOutcome)
        .find({ where: { eventId: id }, order: { resultVersion: 'DESC' } }),
      e.triggerRunId
        ? this.db.getRepository(ForwardTriggerRun).findOneBy({ id: e.triggerRunId })
        : Promise.resolve(null),
    ]);
    return {
      event: row!,
      detection: {
        snapshotId: e.snapshotId,
        slotTime: e.slotTime.toISOString(),
        platform: { chain: e.platformChain, address: e.platformAddress },
        capUsd: s(e.capUsd),
        volume24hUsd: s(e.volume24hUsd),
        vmc: {
          d3: s(e.vmc3dAvg),
          d7: s(e.vmc7dAvg),
          d14: s(e.vmc14dAvg),
          d30: s(e.vmc30dAvg),
        },
        queueOrder: e.queueOrder,
        configVersion: e.configVersion,
        inputsHash: e.inputsHash,
        rulesVersion: e.rulesVersion,
        triggerRun: trigger
          ? {
              id: trigger.id,
              triggeredAt: trigger.triggeredAt.toISOString(),
              batchId: trigger.batchId,
            }
          : null,
        scanSnapshot: e.scanSnapshot,
      },
      highs: highs.map((h) => ({
        id: h.id,
        dateUtc: h.dateUtc,
        periodStart: h.periodStart.toISOString(),
        periodEnd: h.periodEnd.toISOString(),
        source: h.source,
        sourceRevisionId: h.sourceRevisionId,
        revision: h.revision,
        highUsd: h.highUsd?.toFixed() ?? null,
        timeHigh: iso(h.timeHigh),
        quoteCurrency: h.quoteCurrency,
        observedAt: h.observedAt.toISOString(),
        eligibility: h.eligibility,
        reason: h.reason,
        isCurrent: h.isCurrent,
        supersededAt: iso(h.supersededAt),
      })),
      outcomes: outcomes.map(outcomeJson),
      notice: FORWARD_NOTICE,
    };
  }

  async rejections(limit: number, sinceDays?: number) {
    const rows = await this.db.getRepository(ForwardTriggerRejection).find({
      where: {
        providerId: this.providerId,
        ...(sinceDays
          ? { createdAt: MoreThanOrEqual(new Date(Date.now() - sinceDays * DAY_MS)) }
          : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
    });
    const slots = new Map(
      rows.length
        ? (
            await this.db.getRepository(CrawlBatch).find({
              where: { id: In([...new Set(rows.map((r) => r.batchId))]) },
              select: { id: true, slotTime: true },
            })
          ).map((b) => [b.id, b.slotTime.toISOString()])
        : [],
    );
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batchId,
      slotTime: slots.get(r.batchId) ?? null,
      cmcId: r.cmcId,
      symbol: r.symbol,
      starCount: r.starCount,
      reasons: r.reasons,
      observed: r.observed,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Operations, coverage, freshness warnings and the star-group comparison (PDF p.9, p.10). */
  async summary(now = new Date()) {
    const providerId = this.providerId;
    const lists = await this.venues.exchangeListViews(providerId, now);
    const [provider, events, outcomes, watchlist, lastTrigger, triggers, lastUpdate, lastGood] =
      await Promise.all([
        this.db.getRepository(Provider).findOneBy({ id: providerId }),
        this.db.getRepository(ForwardEvent).find({
          where: { providerId },
          select: {
            id: true,
            cmcId: true,
            starCount: true,
            detectedAt: true,
            detectedUtcDate: true,
            evaluationEnd: true,
            status: true,
            pass3d: true,
            pass7d: true,
            pass30d: true,
            weightedPassPoints: true,
            scoreComplete: true,
            resultVersion: true,
            effectiveHorizonHours: true,
            qualityFlags: true,
          },
        }),
        this.db.query(
          `SELECT o.event_id AS "eventId", o.peak_kind AS "peakKind", o.peak_return_pct::text AS "ret",
                  o.completed_days AS "completed", o.covered_days AS "covered",
                  cardinality(o.missing_dates) AS "missing", cardinality(o.invalid_dates) AS "invalid",
                  o.day0_state AS "day0"
             FROM forward_outcome o JOIN forward_event e ON e.id = o.event_id AND e.result_version = o.result_version
            WHERE e.provider_id = $1`,
          [providerId],
        ) as Promise<
          Array<{
            eventId: string;
            peakKind: string;
            ret: string | null;
            completed: number;
            covered: number;
            missing: number;
            invalid: number;
            day0: string;
          }>
        >,
        this.db.getRepository(ForwardTestWatchlist).countBy({ providerId }),
        this.db
          .getRepository(ForwardTriggerRun)
          .findOne({ where: { providerId }, order: { triggeredAt: 'DESC' } }),
        this.db.getRepository(ForwardTriggerRun).count({ where: { providerId } }),
        this.db
          .getRepository(ForwardUpdateRun)
          .findOne({ where: { providerId }, order: { startedAt: 'DESC' } }),
        this.db.getRepository(ForwardUpdateRun).findOne({
          where: { providerId, status: In(['succeeded', 'partial']) },
          order: { startedAt: 'DESC' },
        }),
      ]);
    const byEvent = new Map(outcomes.map((o) => [o.eventId, o]));
    const cohort = cohortReport(
      events.map((e) => {
        const o = byEvent.get(e.id);
        return {
          eventId: e.id,
          cmcId: e.cmcId,
          stars: e.starCount,
          detectedAt: e.detectedAt,
          detectedUtcDate: e.detectedUtcDate,
          evaluationEnd: e.evaluationEnd,
          status: e.status,
          peakKind: (o?.peakKind as 'EXACT' | 'LOWER_BOUND' | 'NONE' | undefined) ?? null,
          peakReturnPct: o?.ret ? new D(o.ret) : null,
          effectiveHorizonHours: e.effectiveHorizonHours,
          passes: [e.pass3d, e.pass7d, e.pass30d] as const,
          weightedPassPoints: e.weightedPassPoints,
          scoreComplete: e.scoreComplete,
          checked: e.resultVersion > 0,
          day0Unconfirmed: e.qualityFlags.some((f) => DAY0_UNCONFIRMED_FLAGS.includes(f)),
        };
      }),
    );
    const sum = (k: 'completed' | 'covered' | 'missing' | 'invalid') =>
      outcomes.reduce((n, o) => n + Number(o[k]), 0);
    const coverage = {
      completedDays: sum('completed'),
      coveredDays: sum('covered'),
      missingDays: sum('missing'),
      invalidDays: sum('invalid'),
      day0Unresolved: outcomes.filter((o) => o.day0 === 'UNRESOLVED').length,
    };
    const warnings: string[] = [];
    const active = events.filter((e) => ACTIVE_EVENT_STATUSES.includes(e.status)).length;
    if (provider && !provider.isLive)
      warnings.push('SYNTHETIC: fixture data, not market data; for demonstration only.');
    const goodAt = lastGood?.finishedAt ?? null;
    if (events.length && (!goodAt || now.getTime() - goodAt.getTime() > 26 * 3_600_000))
      warnings.push(
        `FRESHNESS: ${goodAt ? `the last successful daily High update finished ${goodAt.toISOString()}` : 'no daily High update has completed yet'}; ${active} active events keep their previous outcomes until it runs.`,
      );
    if (lastUpdate?.status === 'failed')
      warnings.push(
        `UPDATE_FAILED: the latest daily update (${lastUpdate.startedAt.toISOString()}) failed: ${lastUpdate.error ?? 'see the run'}; earlier outcomes are kept.`,
      );
    else if (lastUpdate?.status === 'partial')
      warnings.push(
        `UPDATE_PARTIAL (${lastUpdate.startedAt.toISOString()}): ${lastUpdate.notes[0] ?? 'some included Highs were missing; they are retried'}`,
      );
    const day0 = events.filter((e) => e.qualityFlags.includes(FORWARD_REASON.incompleteDay0));
    if (day0.length)
      warnings.push(
        `INCOMPLETE_DAY0: ${day0.length} events cannot be finalized — the signal day's High came before detection (or its time is unknown), no later High reached it, and no intraday High source is configured. Their peaks are lower bounds.`,
      );
    return {
      providerId,
      providerName: provider?.name ?? providerId,
      isLive: provider?.isLive ?? null,
      rulesVersion: FORWARD_RULES_VERSION,
      horizon: {
        hours: HORIZON_HOURS,
        rule: 'Highs from detected_at through 23:59:59.999 UTC of the day containing detected_at + 168 h',
        days: DAY_DEFINITION,
      },
      notice: FORWARD_NOTICE,
      counts: {
        events: events.length,
        watchlistAssets: watchlist,
        byStatus: Object.fromEntries(
          FORWARD_EVENT_STATUSES.map((st) => [st, events.filter((e) => e.status === st).length]),
        ),
        triggerRuns: triggers,
      },
      lastTrigger: lastTrigger
        ? {
            batchId: lastTrigger.batchId,
            triggeredAt: lastTrigger.triggeredAt.toISOString(),
            queueStatus: lastTrigger.queueStatus,
            queueRows: lastTrigger.queueRows,
            created: lastTrigger.created,
            ignored: lastTrigger.ignored,
            rejected: lastTrigger.rejected,
          }
        : null,
      lastUpdate: lastUpdate ? this.updateRunJson(lastUpdate) : null,
      lastSuccessfulUpdate: lastGood ? this.updateRunJson(lastGood) : null,
      coverage,
      warnings,
      cohort: cohort.groups.map(cohortGroupJson),
      /** By detection-time pass pattern and weighted-points band (weighted star ranking). */
      cohortByPattern: cohort.patterns.map(cohortGroupJson),
      cohortByPointsBand: cohort.pointsBands.map(cohortGroupJson),
      /** The exchange lists behind each event's listings (ADR-0007): state and fetch time. */
      exchangeLists: EXCHANGE_LIST_KEYS.map((k) => listStatusJson(lists[k])),
    };
  }

  /** One daily High update: progress while it runs, then its per-event check counts. */
  async updateRun(id: string) {
    const r = await this.db
      .getRepository(ForwardUpdateRun)
      .findOneBy({ id, providerId: this.providerId });
    return r ? this.updateRunJson(r) : null;
  }

  private updateRunJson(r: ForwardUpdateRun) {
    const counts = (r.counts ?? {}) as {
      progress?: { phase: string; processed: number; total: number };
      checks?: Record<string, number>;
      events?: number;
    };
    return {
      id: r.id,
      trigger: r.trigger,
      updateDate: r.updateDate,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: iso(r.finishedAt),
      notes: r.notes,
      error: r.error,
      progress: counts.progress ?? null,
      /** Per-event results (runs before M011 have none). */
      checks: counts.checks ?? null,
    };
  }
}

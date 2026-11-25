import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { dec } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { CutoverService, type CutoverStatus } from '../star-events/cutover.service.js';

import { ObsRun } from './entities/obs-run.entity.js';
import { ObservationResult } from './entities/observation-result.entity.js';
import { ObsRulesChange } from './entities/rules-change.entity.js';
import { type ObservationSummary, type Stats, summarize } from './observation-stats.js';
import {
  type CoverageFilter,
  ELIGIBILITY_LABEL,
  type EligibilityClass,
  FINALIZE_RETRY_MS,
  type FlagFilter,
  OBSERVATION_RULES_V1,
  OBSERVATION_RULES_VERSION,
  OBS_FLAG,
  type ObsSortKey,
  type ObservationStatus,
  PRICE_SOURCE,
  WINDOW_HOURS,
} from './observation.constants.js';

export interface ObservationQuery {
  status?: ObservationStatus;
  eligibility?: EligibilityClass;
  stars?: number;
  coverage?: CoverageFilter;
  flags?: FlagFilter;
  /** Crawl time (t0, the event's UTC date) at or after / before (ISO). */
  from?: string;
  to?: string;
  search?: string;
  sort?: ObsSortKey;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ObservationRow {
  id: string;
  eventId: string;
  cmcId: number;
  symbol: string;
  name: string;
  slug: string | null;
  stars: number;
  points: number | null;
  scoreComplete: boolean | null;
  /** t0: the hourly CMC crawl start (event identity, UTC date and routing; never the window start). */
  crawlAt: string;
  /** The CMC quote time behind the signal (provenance). */
  cmcQuoteAt: string;
  /** CMC USD price at detection: context and identity check only, never an LBank price. */
  cmcPriceUsd: string;
  /** The observation window: from the proven usable time, exactly 168 h. */
  window: {
    start: string;
    end: string;
    source: string;
    uncertain: boolean;
    afterCrawlMs: number;
  } | null;
  pair: { symbol: string | null; quote: string | null; mapping: string };
  eligibility: EligibilityClass;
  eligibilityLabel: string;
  spot: string;
  spotTrading: string | null;
  /** Futures listing evidence from snapshots around the signal (never a Futures price). */
  futures: string;
  reference: {
    status: string;
    tradeId: string | null;
    at: string | null;
    price: string | null;
    qty: string | null;
    delayMs: number | null;
    delayed: boolean | null;
  };
  highest: { price: string; at: string; tradeId: string; pct: string | null } | null;
  lowest: { price: string; at: string; tradeId: string; pct: string | null } | null;
  lowBeforeHighest: { price: string; at: string; tradeId: string | null } | null;
  order: string | null;
  extremesProven: boolean;
  coverage: {
    minutesExpected: number | null;
    minutesPresent: number;
    minutesTraded: number;
    minutesMissing: number;
    /** No gap so far (candle or trade evidence). */
    complete: boolean;
    gaps: Array<{ from: string; to: string; state: string; detail?: string }>;
  };
  freshness: {
    /** Exclusive end of the window part the candles were fetched through. */
    dataThrough: string | null;
    lastSourceFetchAt: string | null;
    lastFetchAttemptAt: string | null;
    lastFetchError: string | null;
    /** Gaps are retried until then; afterwards the status is terminal. */
    retryUntil: string | null;
    /** The last recomputation (not data freshness). */
    lastRecomputedAt: string | null;
  };
  flags: string[];
  status: ObservationStatus;
  /** Not FINAL: values are provisional or partial and never in final statistics. */
  provisional: boolean;
  reasons: string[];
  finalizedAt: string | null;
  rulesVersion: string;
  resultVersion: number;
  /** Events of the same coin in the observation table, and of them those whose windows overlap this one. */
  coinEvents: number;
  overlapping: number;
  isLive: boolean;
}

interface RawRow {
  id: string;
  event_id: string;
  cmc_id: number;
  symbol: string;
  name: string;
  slug: string | null;
  star_count: number;
  weighted_pass_points: number | null;
  score_complete: boolean | null;
  t0: Date;
  source_updated_at: Date;
  cmc_price_usd: string;
  actionable_source: string | null;
  actionable_evidence: Record<string, unknown> | null;
  observation_start: Date | null;
  observation_end: Date | null;
  pair_symbol: string | null;
  quote_asset: string | null;
  mapping_status: string;
  eligibility: EligibilityClass;
  spot_status: string;
  spot_trading: string | null;
  futures_status: string;
  reference_status: string;
  reference_trade_id: string | null;
  reference_at: Date | null;
  reference_price: string | null;
  reference_qty: string | null;
  reference_delay_ms: number | null;
  reference_delayed: boolean | null;
  highest_price: string | null;
  highest_at: Date | null;
  highest_trade_id: string | null;
  highest_return_pct: string | null;
  lowest_price: string | null;
  lowest_at: Date | null;
  lowest_trade_id: string | null;
  lowest_return_pct: string | null;
  low_before_highest_price: string | null;
  low_before_highest_at: Date | null;
  low_before_highest_trade_id: string | null;
  extremes_order: string | null;
  extremes_proven: boolean;
  minutes_expected: number | null;
  minutes_present: number;
  minutes_traded: number;
  minutes_missing: number;
  gaps: Array<{ from: string; to: string; state: string; detail?: string }> | null;
  data_through: Date | null;
  last_source_fetch_at: Date | null;
  last_fetch_attempt_at: Date | null;
  last_fetch_error: string | null;
  retry_until: Date | null;
  flags: string[];
  status: ObservationStatus;
  reasons: string[];
  last_update_at: Date | null;
  finalized_at: Date | null;
  rules_version: string;
  result_version: number;
  is_live: boolean;
  coin_events: string;
  overlapping: string;
}

/** Exact decimal text without trailing zeros (display); null stays null. */
const plainText = (v: string | null): string | null => (v === null ? null : dec(v)!.toFixed());
const isoOf = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const SORT_SQL: Record<ObsSortKey, string> = {
  detected: 'o.t0',
  start: 'o.observation_start',
  stars: 'e.star_count',
  points: 'e.weighted_pass_points',
  highest: 'o.highest_return_pct',
  lowest: 'o.lowest_return_pct',
  referenceDelay: 'o.reference_delay_ms',
  coverage: '(o.minutes_present::numeric / NULLIF(o.minutes_expected, 0))',
  symbol: 'e.symbol',
};

/** The v2 window of a row, falling back to the crawl-based v1 window while the start is unknown. */
const START_SQL = 'coalesce(o.observation_start, o.t0)';
const END_SQL = 'coalesce(o.observation_end, o.window_end)';

/**
 * Read-only queries of the LBank Spot Price Observation for the dashboard API, the CLI and the
 * export (rules v2). Every price is an LBank Spot trade (`PRICE_SOURCE`); the CMC price is labelled
 * context. Exact decimal strings throughout; nothing here writes.
 */
@Injectable()
export class ObservationReadService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly cutover: CutoverService,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  private where(q: ObservationQuery): { sql: string; params: unknown[] } {
    const params: unknown[] = [this.providerId];
    const parts = ['o.provider_id = $1'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      parts.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (q.status) add('o.status = ?', q.status);
    if (q.eligibility) add('o.eligibility = ?', q.eligibility);
    if (q.stars) add('e.star_count = ?', q.stars);
    if (q.coverage === 'complete')
      parts.push(`jsonb_array_length(o.gaps) = 0 AND o.minutes_present > 0`);
    if (q.coverage === 'partial') parts.push(`jsonb_array_length(o.gaps) > 0`);
    if (q.flags === 'any') parts.push('cardinality(o.flags) > 0');
    if (q.flags === 'none') parts.push('cardinality(o.flags) = 0');
    if (q.flags === 'spike')
      add('o.flags && ?::text[]', [OBS_FLAG.singleTradeHigh, OBS_FLAG.singleTradeLow]);
    if (q.flags === 'delayed') add('? = ANY (o.flags)', OBS_FLAG.referenceDelayed);
    if (q.from) add('o.t0 >= ?', new Date(q.from));
    if (q.to) add('o.t0 < ?', new Date(q.to));
    if (q.search) {
      const s = q.search.trim();
      if (/^\d+$/.test(s)) add('e.cmc_id = ?', Number(s));
      else
        add(
          '(e.symbol ILIKE ? OR e.name ILIKE ? OR o.pair_symbol ILIKE ?)',
          `%${s.replace(/[%_\\]/g, '\\$&')}%`,
        );
    }
    return { sql: parts.join(' AND '), params };
  }

  private select(where: string, tail: string) {
    return `SELECT o.*, e.cmc_id, e.symbol, e.name, e.slug, e.star_count, e.weighted_pass_points, e.score_complete,
                   e.source_updated_at, e.cmc_price_usd::text AS cmc_price_usd,
                   o.reference_price::text AS reference_price, o.reference_qty::text AS reference_qty,
                   o.highest_price::text AS highest_price, o.lowest_price::text AS lowest_price,
                   o.highest_return_pct::text AS highest_return_pct, o.lowest_return_pct::text AS lowest_return_pct,
                   o.low_before_highest_price::text AS low_before_highest_price,
                   (SELECT count(*) FROM lbank_observation o2 JOIN lbank_obs_event e2 ON e2.id = o2.event_id
                     WHERE o2.provider_id = o.provider_id AND e2.cmc_id = e.cmc_id) AS coin_events,
                   (SELECT count(*) FROM lbank_observation o2 JOIN lbank_obs_event e2 ON e2.id = o2.event_id
                     WHERE o2.provider_id = o.provider_id AND e2.cmc_id = e.cmc_id AND o2.id <> o.id
                       AND coalesce(o2.observation_start, o2.t0) < ${END_SQL}
                       AND ${START_SQL} < coalesce(o2.observation_end, o2.window_end)) AS overlapping
              FROM lbank_observation o JOIN lbank_obs_event e ON e.id = o.event_id
             WHERE ${where} ${tail}`;
  }

  private toRow(r: RawRow): ObservationRow {
    const ev = r.actionable_evidence ?? {};
    const gaps = r.gaps ?? [];
    return {
      id: r.id,
      eventId: r.event_id,
      cmcId: r.cmc_id,
      symbol: r.symbol,
      name: r.name,
      slug: r.slug,
      stars: r.star_count,
      points: r.weighted_pass_points,
      scoreComplete: r.score_complete,
      crawlAt: r.t0.toISOString(),
      cmcQuoteAt: r.source_updated_at.toISOString(),
      cmcPriceUsd: plainText(r.cmc_price_usd)!,
      window:
        r.observation_start && r.observation_end
          ? {
              start: r.observation_start.toISOString(),
              end: r.observation_end.toISOString(),
              source: r.actionable_source ?? 'UNKNOWN',
              uncertain: ev.uncertain === true,
              afterCrawlMs: r.observation_start.getTime() - r.t0.getTime(),
            }
          : null,
      pair: { symbol: r.pair_symbol, quote: r.quote_asset, mapping: r.mapping_status },
      eligibility: r.eligibility,
      eligibilityLabel: ELIGIBILITY_LABEL[r.eligibility],
      spot: r.spot_status,
      spotTrading: r.spot_trading,
      futures: r.futures_status,
      reference: {
        status: r.reference_status,
        tradeId: r.reference_trade_id,
        at: isoOf(r.reference_at),
        price: plainText(r.reference_price),
        qty: plainText(r.reference_qty),
        delayMs: r.reference_delay_ms,
        delayed: r.reference_delayed,
      },
      highest:
        r.highest_price !== null && r.highest_at && r.highest_trade_id
          ? {
              price: plainText(r.highest_price)!,
              at: r.highest_at.toISOString(),
              tradeId: r.highest_trade_id,
              pct: plainText(r.highest_return_pct),
            }
          : null,
      lowest:
        r.lowest_price !== null && r.lowest_at && r.lowest_trade_id
          ? {
              price: plainText(r.lowest_price)!,
              at: r.lowest_at.toISOString(),
              tradeId: r.lowest_trade_id,
              pct: plainText(r.lowest_return_pct),
            }
          : null,
      lowBeforeHighest:
        r.low_before_highest_price !== null && r.low_before_highest_at
          ? {
              price: plainText(r.low_before_highest_price)!,
              at: r.low_before_highest_at.toISOString(),
              tradeId: r.low_before_highest_trade_id,
            }
          : null,
      order: r.extremes_order,
      extremesProven: r.extremes_proven,
      coverage: {
        minutesExpected: r.minutes_expected,
        minutesPresent: r.minutes_present,
        minutesTraded: r.minutes_traded,
        minutesMissing: r.minutes_missing,
        complete: gaps.length === 0 && r.minutes_present > 0,
        gaps,
      },
      freshness: {
        dataThrough: isoOf(r.data_through),
        lastSourceFetchAt: isoOf(r.last_source_fetch_at),
        lastFetchAttemptAt: isoOf(r.last_fetch_attempt_at),
        lastFetchError: r.last_fetch_error,
        retryUntil: isoOf(r.retry_until),
        lastRecomputedAt: isoOf(r.last_update_at),
      },
      flags: r.flags ?? [],
      status: r.status,
      provisional: r.status !== 'FINAL',
      reasons: r.reasons,
      finalizedAt: isoOf(r.finalized_at),
      rulesVersion: r.rules_version,
      resultVersion: r.result_version,
      coinEvents: Number(r.coin_events),
      overlapping: Number(r.overlapping),
      isLive: r.is_live,
    };
  }

  async list(q: ObservationQuery): Promise<{ rows: ObservationRow[]; total: number }> {
    const w = this.where(q);
    const sort = SORT_SQL[q.sort ?? 'detected'];
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(500, Math.max(1, q.limit ?? 100));
    const offset = Math.max(0, q.offset ?? 0);
    const [{ n }] = (await this.db.query(
      `SELECT count(*)::int AS n FROM lbank_observation o JOIN lbank_obs_event e ON e.id = o.event_id WHERE ${w.sql}`,
      w.params,
    )) as [{ n: number }];
    const rows = (await this.db.query(
      this.select(
        w.sql,
        `ORDER BY ${sort} ${dir} NULLS LAST, o.t0 DESC, o.id LIMIT ${limit} OFFSET ${offset}`,
      ),
      w.params,
    )) as RawRow[];
    return { rows: rows.map((r) => this.toRow(r)), total: n };
  }

  async summary(q: Omit<ObservationQuery, 'sort' | 'dir' | 'limit' | 'offset'> = {}): Promise<{
    priceSource: string;
    rulesVersion: string;
    windowHours: number;
    retryHours: number;
    cutover: CutoverStatus;
    lastRun: {
      id: string;
      trigger: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      notes: string[];
      fetchedNewData: boolean | null;
      candlesStored: number | null;
      tradeMinutesChecked: number | null;
    } | null;
    lastSuccessfulRunAt: string | null;
    freshness: {
      activeObservations: number;
      /** The oldest fetched-through time among windows still open, and its lag behind now. */
      oldestOpenDataThrough: string | null;
      oldestOpenLagMs: number | null;
      lastSourceFetchAt: string | null;
      pairsWithFetchErrors: number;
      observationsAwaitingVerification: number;
    };
    summary: ReturnType<typeof serializeSummary>;
  }> {
    const w = this.where(q);
    const rows = (await this.db.query(
      `SELECT o.id, e.cmc_id, e.star_count, o.status, o.rules_version, o.eligibility,
              o.observation_start, o.observation_end, o.flags,
              o.highest_return_pct::text AS highest_return_pct, o.lowest_return_pct::text AS lowest_return_pct
         FROM lbank_observation o JOIN lbank_obs_event e ON e.id = o.event_id WHERE ${w.sql}`,
      w.params,
    )) as Array<{
      id: string;
      cmc_id: number;
      star_count: number;
      status: ObservationStatus;
      rules_version: string;
      eligibility: EligibilityClass;
      observation_start: Date | null;
      observation_end: Date | null;
      flags: string[];
      highest_return_pct: string | null;
      lowest_return_pct: string | null;
    }>;
    const s = summarize(
      rows.map((r) => ({
        id: r.id,
        cmcId: r.cmc_id,
        stars: r.star_count,
        status: r.status,
        rulesVersion: r.rules_version,
        eligibility: r.eligibility,
        startMs: r.observation_start?.getTime() ?? null,
        endMs: r.observation_end?.getTime() ?? null,
        highestPct: dec(r.highest_return_pct),
        lowestPct: dec(r.lowest_return_pct),
        flags: r.flags ?? [],
      })),
    );
    const runs = this.db.getRepository(ObsRun);
    const last = await runs.findOne({
      where: { providerId: this.providerId },
      order: { startedAt: 'DESC' },
    });
    const ok = await runs.findOne({
      where: [
        { providerId: this.providerId, status: 'succeeded' },
        { providerId: this.providerId, status: 'partial' },
      ],
      order: { startedAt: 'DESC' },
    });
    const now = new Date();
    const [fresh] = (await this.db.query(
      `SELECT count(*) FILTER (WHERE o.status = 'ACTIVE')::int AS active,
              min(o.data_through) FILTER (WHERE o.status = 'ACTIVE' AND o.observation_end > $2) AS oldest,
              count(*) FILTER (WHERE o.status = 'ACTIVE' AND 'VERIFICATION_PENDING' = ANY (o.reasons))::int AS awaiting
         FROM lbank_observation o WHERE o.provider_id = $1`,
      [this.providerId, now],
    )) as [{ active: number; oldest: Date | null; awaiting: number }];
    const [pairs] = (await this.db.query(
      `SELECT max(greatest(p.last_success_at, p.trades_last_success_at)) AS last_ok,
              count(*) FILTER (WHERE p.last_fetch_status IN ('error', 'unsupported'))::int AS errors
         FROM lbank_spot_pair p
        WHERE EXISTS (SELECT 1 FROM lbank_observation o WHERE o.pair_id = p.id AND o.finalized_at IS NULL)`,
    )) as [{ last_ok: Date | null; errors: number }];
    const counts = (last?.counts ?? null) as {
      fetchedNewData?: boolean;
      pairs?: { stored?: number };
      trades?: { minutesChecked?: number };
    } | null;
    return {
      priceSource: PRICE_SOURCE,
      rulesVersion: OBSERVATION_RULES_VERSION,
      windowHours: WINDOW_HOURS,
      retryHours: FINALIZE_RETRY_MS / 3_600_000,
      cutover: await this.cutover.status(this.providerId, now),
      lastRun: last
        ? {
            id: last.id,
            trigger: last.trigger,
            status: last.status,
            startedAt: last.startedAt.toISOString(),
            finishedAt: isoOf(last.finishedAt),
            notes: last.notes,
            fetchedNewData: counts?.fetchedNewData ?? null,
            candlesStored: counts?.pairs?.stored ?? null,
            tradeMinutesChecked: counts?.trades?.minutesChecked ?? null,
          }
        : null,
      lastSuccessfulRunAt: ok ? (ok.finishedAt ?? ok.startedAt).toISOString() : null,
      freshness: {
        activeObservations: fresh.active,
        oldestOpenDataThrough: isoOf(fresh.oldest),
        oldestOpenLagMs: fresh.oldest ? now.getTime() - new Date(fresh.oldest).getTime() : null,
        lastSourceFetchAt: isoOf(pairs?.last_ok ?? null),
        pairsWithFetchErrors: pairs?.errors ?? 0,
        observationsAwaitingVerification: fresh.awaiting,
      },
      summary: serializeSummary(s),
    };
  }

  async detail(id: string): Promise<(ObservationRow & Record<string, unknown>) | null> {
    const rows = (await this.db.query(this.select('o.id = $1 AND o.provider_id = $2', ''), [
      id,
      this.providerId,
    ])) as RawRow[];
    if (!rows[0]) return null;
    const ev = (await this.db.query(
      `SELECT e.*, e.cmc_price_usd::text AS cmc_price_usd FROM lbank_obs_event e WHERE e.id = $1`,
      [rows[0].event_id],
    )) as Array<Record<string, unknown>>;
    const obs = (await this.db.query(
      `SELECT mapping_evidence, eligibility_evidence, eligibility_checked_at, pair_id, actionable_at,
              actionable_evidence, reference_evidence, extremes_evidence, flags_evidence, evidence_sha256,
              window_end, entry_at, entry_price::text AS entry_price, entry_delay_ms, entry_stale,
              high_price::text AS high_price, high_bar_at, low_price::text AS low_price, low_bar_at,
              max_rise_pct::text AS max_rise_pct, max_drop_pct::text AS max_drop_pct, covered_bars, expected_bars
         FROM lbank_observation WHERE id = $1`,
      [id],
    )) as Array<Record<string, unknown> & { pair_id: number | null }>;
    const o = obs[0]!;
    const pair = o.pair_id
      ? ((
          (await this.db.query(
            `SELECT symbol, base, quote, first_bar_at, synced_until, last_fetch_at, last_success_at,
                    last_fetch_status, last_error, unsupported_since, trades_last_attempt_at,
                    trades_last_success_at, trades_last_error
               FROM lbank_spot_pair WHERE id = $1`,
            [o.pair_id],
          )) as Array<Record<string, unknown>>
        )[0] ?? null)
      : null;
    const results = await this.db
      .getRepository(ObservationResult)
      .find({ where: { observationId: id }, order: { resultVersion: 'ASC' } });
    const changes = await this.db
      .getRepository(ObsRulesChange)
      .find({ where: { observationId: id }, order: { changedAt: 'ASC' } });
    const e = ev[0] ?? {};
    const row = this.toRow(rows[0]);
    const hasV1 =
      o.entry_price !== null || changes.some((c) => c.fromRulesVersion === OBSERVATION_RULES_V1);
    return {
      ...row,
      displayedRulesVersion: row.rulesVersion,
      event: {
        detectedUtcDate: e.detected_utc_date,
        crawlAt: e.detected_at,
        cmcQuoteAt: e.source_updated_at,
        sourceBatchId: e.source_batch_id,
        slotTime: e.slot_time,
        createdAt: e.created_at,
        rank: e.rank,
        pass: [e.pass_3d, e.pass_7d, e.pass_30d],
        multiples: [e.multiple_3d, e.multiple_7d, e.multiple_30d],
        currentVmc: e.current_vmc,
        weightedStrength: e.weighted_strength,
        rankingRulesetVersion: e.ranking_ruleset_version,
        rulesetVersion: e.ruleset_version,
        lbankPairs: e.lbank_pairs,
      },
      actionableEvidence: o.actionable_evidence ?? null,
      referenceEvidence: o.reference_evidence ?? null,
      extremesEvidence: o.extremes_evidence ?? null,
      flagsEvidence: o.flags_evidence ?? null,
      evidenceSha256: o.evidence_sha256 ?? null,
      mappingEvidence: o.mapping_evidence ?? null,
      eligibilityEvidence: o.eligibility_evidence ?? null,
      eligibilityCheckedAt: isoOf((o.eligibility_checked_at as Date | null) ?? null),
      pairState: pair,
      legacyV1: hasV1
        ? {
            note: 'rules lbank-spot-obs-1 audit values (candle OPEN at the crawl time); they never drive a displayed value',
            windowEnd: isoOf(o.window_end as Date | null),
            entryAt: isoOf(o.entry_at as Date | null),
            entryPrice: plainText(o.entry_price as string | null),
            entryDelayMs: o.entry_delay_ms,
            entryStale: o.entry_stale,
            highPrice: plainText(o.high_price as string | null),
            highBarAt: isoOf(o.high_bar_at as Date | null),
            lowPrice: plainText(o.low_price as string | null),
            lowBarAt: isoOf(o.low_bar_at as Date | null),
            maxRisePct: plainText(o.max_rise_pct as string | null),
            maxDropPct: plainText(o.max_drop_pct as string | null),
            coveredBars: o.covered_bars,
            expectedBars: o.expected_bars,
          }
        : null,
      rulesChanges: changes.map((c) => ({
        from: c.fromRulesVersion,
        to: c.toRulesVersion,
        fromStatus: c.fromStatus,
        fromResultVersion: c.fromResultVersion,
        fromFinalizedAt: isoOf(c.fromFinalizedAt),
        changedAt: c.changedAt.toISOString(),
        reason: c.reason,
        previous: c.previous,
      })),
      results: results.map((r) => ({
        version: r.resultVersion,
        status: r.status,
        eligibility: r.eligibility,
        reasons: r.reasons,
        rulesVersion: r.rulesVersion,
        highestReturnPct: r.highestReturnPct?.toFixed() ?? null,
        lowestReturnPct: r.lowestReturnPct?.toFixed() ?? null,
        referencePrice: r.referencePrice?.toFixed() ?? null,
        observationStart: isoOf(r.observationStart),
        flags: r.flags,
        v1MaxRisePct: r.maxRisePct?.toFixed() ?? null,
        v1MaxDropPct: r.maxDropPct?.toFixed() ?? null,
        evidenceSha256: r.evidenceSha256 ?? r.seriesSha256,
        computedAt: r.computedAt.toISOString(),
      })),
    };
  }

  /**
   * The same coin's other observations whose windows share at least one moment with this one's
   * (correlated: one price path), with the shared interval. Null when the observation is unknown.
   */
  async overlaps(id: string): Promise<{
    observation: ObservationRow;
    coin: { cmcId: number; events: number };
    overlaps: Array<
      ObservationRow & {
        relation: 'same_utc_day' | 'earlier' | 'later';
        overlapStart: string;
        overlapEnd: string;
        overlapHours: string;
      }
    >;
  } | null> {
    const [me] = (await this.db.query(this.select('o.id = $1 AND o.provider_id = $2', ''), [
      id,
      this.providerId,
    ])) as RawRow[];
    if (!me) return null;
    const meStart = me.observation_start ?? me.t0;
    const meEnd = me.observation_end ?? new Date(me.t0.getTime() + WINDOW_HOURS * 3_600_000);
    const others = (await this.db.query(
      this.select(
        `o.provider_id = $1 AND e.cmc_id = $2 AND o.id <> $3 AND ${START_SQL} < $4 AND $5 < ${END_SQL}`,
        'ORDER BY o.t0, o.id',
      ),
      [this.providerId, me.cmc_id, me.id, meEnd, meStart],
    )) as RawRow[];
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return {
      observation: this.toRow(me),
      coin: { cmcId: me.cmc_id, events: Number(me.coin_events) },
      overlaps: others.map((x) => {
        const xs = x.observation_start ?? x.t0;
        const xe = x.observation_end ?? new Date(x.t0.getTime() + WINDOW_HOURS * 3_600_000);
        const start = Math.max(xs.getTime(), meStart.getTime());
        const end = Math.min(xe.getTime(), meEnd.getTime());
        return {
          ...this.toRow(x),
          relation: day(x.t0) === day(me.t0) ? 'same_utc_day' : x.t0 < me.t0 ? 'earlier' : 'later',
          overlapStart: new Date(start).toISOString(),
          overlapEnd: new Date(end).toISOString(),
          // Display only (hours of shared window), never a strategy input.
          overlapHours: ((end - start) / 3_600_000).toFixed(1),
        };
      }),
    };
  }

  /** Every filtered observation as CSV (full precision; one row per event; rules v2 values). */
  async csv(q: Omit<ObservationQuery, 'limit' | 'offset'>): Promise<string> {
    const header = [
      'observation_id',
      'event_id',
      'cmc_id',
      'symbol',
      'name',
      'stars',
      'weighted_pass_points',
      'cmc_crawl_time_utc',
      'cmc_quote_time_utc',
      'cmc_price_usd_context',
      'observation_start_utc',
      'observation_end_utc',
      'start_proven_by',
      'start_after_crawl_ms',
      'start_timing_uncertain',
      'price_source',
      'lbank_pair',
      'quote_asset',
      'mapping_status',
      'reference_status',
      'reference_trade_id',
      'reference_time_utc',
      'reference_price',
      'reference_qty',
      'reference_delay_ms',
      'reference_delayed',
      'highest_price',
      'highest_time_utc',
      'highest_trade_id',
      'highest_return_pct',
      'lowest_price',
      'lowest_time_utc',
      'lowest_trade_id',
      'lowest_return_pct',
      'extremes_order',
      'low_before_highest',
      'low_before_highest_time_utc',
      'extremes_proven',
      'minutes_expected',
      'minutes_present',
      'minutes_traded',
      'minutes_missing',
      'gaps',
      'data_through_utc',
      'last_source_fetch_utc',
      'last_fetch_attempt_utc',
      'last_fetch_error',
      'retry_until_utc',
      'spot_futures_class',
      'spot_status',
      'spot_trading',
      'futures_listing_evidence',
      'flags',
      'status',
      'provisional',
      'reasons',
      'coin_events',
      'overlapping_events',
      'last_recomputed_utc',
      'finalized_at_utc',
      'rules_version',
      'result_version',
      'data_label',
    ];
    // CSV cell: formula-like text is defused with a leading quote; numbers (also negative) stay as they are.
    const cell = (v: unknown) => {
      let t = v === null || v === undefined ? '' : String(v);
      if (/^[=+@\t\r]/.test(t) || (t.startsWith('-') && !/^-\d+(\.\d+)?$/.test(t))) t = `'${t}`;
      return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [header.join(',')];
    let offset = 0;
    for (;;) {
      const page = await this.list({ ...q, limit: 500, offset });
      for (const r of page.rows)
        lines.push(
          [
            r.id,
            r.eventId,
            r.cmcId,
            r.symbol,
            r.name,
            r.stars,
            r.points,
            r.crawlAt,
            r.cmcQuoteAt,
            r.cmcPriceUsd,
            r.window?.start,
            r.window?.end,
            r.window?.source,
            r.window?.afterCrawlMs,
            r.window?.uncertain,
            PRICE_SOURCE,
            r.pair.symbol,
            r.pair.quote,
            r.pair.mapping,
            r.reference.status,
            r.reference.tradeId,
            r.reference.at,
            r.reference.price,
            r.reference.qty,
            r.reference.delayMs,
            r.reference.delayed,
            r.highest?.price,
            r.highest?.at,
            r.highest?.tradeId,
            r.highest?.pct,
            r.lowest?.price,
            r.lowest?.at,
            r.lowest?.tradeId,
            r.lowest?.pct,
            r.order,
            r.lowBeforeHighest?.price,
            r.lowBeforeHighest?.at,
            r.extremesProven,
            r.coverage.minutesExpected,
            r.coverage.minutesPresent,
            r.coverage.minutesTraded,
            r.coverage.minutesMissing,
            r.coverage.gaps
              .map((g) => `${g.from}/${g.to}:${g.state}${g.detail ? `(${g.detail})` : ''}`)
              .join(' '),
            r.freshness.dataThrough,
            r.freshness.lastSourceFetchAt,
            r.freshness.lastFetchAttemptAt,
            r.freshness.lastFetchError,
            r.freshness.retryUntil,
            r.eligibilityLabel,
            r.spot,
            r.spotTrading,
            r.futures,
            r.flags.join(' '),
            r.status,
            r.provisional,
            r.reasons.join(' '),
            r.coinEvents,
            r.overlapping,
            r.freshness.lastRecomputedAt,
            r.finalizedAt,
            r.rulesVersion,
            r.resultVersion,
            r.isLive ? 'LIVE' : 'SYNTHETIC',
          ]
            .map(cell)
            .join(','),
        );
      offset += page.rows.length;
      if (!page.rows.length || offset >= page.total) break;
    }
    return `${lines.join('\n')}\n`;
  }

  async runs(limit = 20) {
    const rows = await this.db
      .getRepository(ObsRun)
      .find({ where: { providerId: this.providerId }, order: { startedAt: 'DESC' }, take: limit });
    return rows.map((r) => {
      const c = (r.counts ?? {}) as {
        fetchedNewData?: boolean;
        pairs?: { stored?: number; requests?: number };
        trades?: { minutesChecked?: number; requests?: number };
      };
      return {
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: isoOf(r.finishedAt),
        fetchedNewData: c.fetchedNewData ?? null,
        candlesStored: c.pairs?.stored ?? null,
        tradeMinutesChecked: c.trades?.minutesChecked ?? null,
        notes: r.notes,
        error: r.error,
      };
    });
  }

  /**
   * Routing check after the cutover: every published queue row at or after it is an observation
   * event, ignored as a duplicate key, or rejected with reasons; no event is missing its
   * observation; no legacy event was created at or after the cutover; and every observation of the
   * current rules has a proven start no earlier than its crawl time.
   */
  async routingCheck(): Promise<{
    cutover: CutoverStatus;
    batchesAfterCutover: number;
    batchesWithoutIntake: Array<{ batchId: string; slotTime: string; queueStatus: string | null }>;
    intakeRowsUnaccounted: number;
    eventsWithoutObservation: number;
    legacyEventsAfterCutover: number;
    observationEventsBeforeCutover: number;
    duplicateKeysAcrossTrackers: number;
    observationsWithoutStart: number;
    ok: boolean;
  }> {
    const cutover = await this.cutover.status(this.providerId, new Date());
    const p = [this.providerId];
    const at = cutover.cutoverAt;
    const one = async (sql: string, params: unknown[]) =>
      Number(((await this.db.query(sql, params)) as Array<{ n: string }>)[0]?.n ?? 0);
    const batches = at
      ? ((await this.db.query(
          `SELECT b.id, b.slot_time, r.queue_status FROM crawl_batch b LEFT JOIN scan_run r ON r.batch_id = b.id
            WHERE b.provider_id = $1 AND b.crawled_at >= $2 AND r.status = 'succeeded'`,
          [this.providerId, at],
        )) as Array<{ id: string; slot_time: Date; queue_status: string | null }>)
      : [];
    const intakeBatches = new Set(
      (
        (await this.db.query(
          `SELECT DISTINCT batch_id FROM lbank_obs_intake_run WHERE provider_id = $1`,
          p,
        )) as Array<{ batch_id: string }>
      ).map((r) => r.batch_id),
    );
    // Hourly runs record the intake; reprocessing never does (like the legacy trigger, F3).
    const without = batches
      .filter((b) => !intakeBatches.has(b.id) && b.queue_status === 'PUBLISHED')
      .map((b) => ({
        batchId: b.id,
        slotTime: b.slot_time.toISOString(),
        queueStatus: b.queue_status,
      }));
    const unaccounted = await one(
      `SELECT count(*) AS n FROM lbank_obs_intake_run WHERE provider_id = $1 AND queue_rows <> created + ignored + rejected`,
      p,
    );
    const orphans = await one(
      `SELECT count(*) AS n FROM lbank_obs_event e LEFT JOIN lbank_observation o ON o.event_id = e.id WHERE e.provider_id = $1 AND o.id IS NULL`,
      p,
    );
    const legacyAfter = at
      ? await one(
          `SELECT count(*) AS n FROM forward_event WHERE provider_id = $1 AND detected_at >= $2`,
          [this.providerId, at],
        )
      : 0;
    const newBefore = at
      ? await one(
          `SELECT count(*) AS n FROM lbank_obs_event WHERE provider_id = $1 AND detected_at < $2`,
          [this.providerId, at],
        )
      : 0;
    const dupKeys = await one(
      `SELECT count(*) AS n FROM lbank_obs_event n JOIN forward_event f
         ON f.provider_id = n.provider_id AND f.cmc_id = n.cmc_id AND f.detected_utc_date = n.detected_utc_date AND f.star_count = n.star_count
        WHERE n.provider_id = $1`,
      p,
    );
    const withoutStart = await one(
      `SELECT count(*) AS n FROM lbank_observation WHERE provider_id = $1 AND rules_version = $2 AND observation_start IS NULL AND finalized_at IS NULL AND mapping_status = 'OK'`,
      [this.providerId, OBSERVATION_RULES_VERSION],
    );
    return {
      cutover,
      batchesAfterCutover: batches.length,
      batchesWithoutIntake: without,
      intakeRowsUnaccounted: unaccounted,
      eventsWithoutObservation: orphans,
      legacyEventsAfterCutover: legacyAfter,
      observationEventsBeforeCutover: newBefore,
      duplicateKeysAcrossTrackers: dupKeys,
      observationsWithoutStart: withoutStart,
      ok: !without.length && !unaccounted && !orphans && !legacyAfter && !newBefore && !dupKeys,
    };
  }
}

const statsJson = (s: Stats) => ({
  n: s.n,
  mean: s.mean?.toFixed() ?? null,
  median: s.median?.toFixed() ?? null,
  p25: s.p25?.toFixed() ?? null,
  p75: s.p75?.toFixed() ?? null,
  min: s.min?.toFixed() ?? null,
  max: s.max?.toFixed() ?? null,
});

export function serializeSummary(s: ObservationSummary) {
  return {
    ...s,
    final: {
      ...s.final,
      highest: statsJson(s.final.highest),
      lowest: statsJson(s.final.lowest),
      byStars: s.final.byStars.map((g) => ({
        ...g,
        highest: statsJson(g.highest),
        lowest: statsJson(g.lowest),
      })),
      byEligibility: s.final.byEligibility.map((g) => ({
        ...g,
        label: ELIGIBILITY_LABEL[g.key as EligibilityClass],
        highest: statsJson(g.highest),
        lowest: statsJson(g.lowest),
      })),
    },
  };
}

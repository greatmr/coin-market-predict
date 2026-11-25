import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { dec } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { CutoverService, type CutoverStatus } from '../star-events/cutover.service.js';

import { ObsRun } from './entities/obs-run.entity.js';
import { ObservationResult } from './entities/observation-result.entity.js';
import { type ObservationSummary, type Stats, summarize } from './observation-stats.js';
import {
  type CoverageFilter,
  ELIGIBILITY_LABEL,
  type EligibilityClass,
  MAX_ENTRY_DELAY_MS,
  MAX_ENTRY_STALENESS_MS,
  OBSERVATION_RULES_VERSION,
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
  /** t0 at or after / before (ISO). */
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
  signalAt: string;
  windowEnd: string;
  /** CMC USD price at detection: context only, never an LBank entry. */
  cmcPriceUsd: string;
  pair: { symbol: string | null; quote: string | null; mapping: string };
  eligibility: EligibilityClass;
  eligibilityLabel: string;
  spot: string;
  spotTrading: string | null;
  futures: string;
  entry: {
    at: string;
    price: string;
    delayMs: number;
    stale: boolean | null;
    lastTradeAt: string | null;
  } | null;
  high: { price: string; barAt: string } | null;
  low: { price: string; barAt: string } | null;
  maxRisePct: string | null;
  maxDropPct: string | null;
  lowBeforeHigh: { price: string; barAt: string } | null;
  extremeOrder: string | null;
  coverage: {
    expectedBars: number;
    coveredBars: number;
    missingBars: number;
    tradedBars: number;
    observedThrough: string | null;
    /** Every expected bar so far is present. */
    complete: boolean;
    startUnobservedMs: number;
    boundaryUnobservedMs: number;
    missingRanges: Array<[string, string]>;
  };
  status: ObservationStatus;
  /** Not FINAL: extremes are provisional and never in final statistics. */
  provisional: boolean;
  reasons: string[];
  lastUpdateAt: string | null;
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
  window_end: Date;
  cmc_price_usd: string;
  pair_symbol: string | null;
  quote_asset: string | null;
  mapping_status: string;
  eligibility: EligibilityClass;
  spot_status: string;
  spot_trading: string | null;
  futures_status: string;
  entry_at: Date | null;
  entry_price: string | null;
  entry_delay_ms: number | null;
  entry_stale: boolean | null;
  entry_last_trade_at: Date | null;
  high_price: string | null;
  high_bar_at: Date | null;
  low_price: string | null;
  low_bar_at: Date | null;
  max_rise_pct: string | null;
  max_drop_pct: string | null;
  low_before_high_price: string | null;
  low_before_high_bar_at: Date | null;
  extreme_order: string | null;
  expected_bars: number;
  covered_bars: number;
  missing_bars: number;
  traded_bars: number;
  observed_through: Date | null;
  start_unobserved_ms: number;
  boundary_unobserved_ms: number;
  missing_ranges: Array<[string, string]>;
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
const isoOf = (d: Date | null) => (d ? d.toISOString() : null);

const SORT_SQL: Record<ObsSortKey, string> = {
  detected: 'o.t0',
  stars: 'e.star_count',
  points: 'e.weighted_pass_points',
  rise: 'o.max_rise_pct',
  drop: 'o.max_drop_pct',
  entryDelay: 'o.entry_delay_ms',
  coverage: '(o.covered_bars::numeric / NULLIF(o.expected_bars, 0))',
  symbol: 'e.symbol',
};

/**
 * Read-only queries of the LBank Spot Price Observation for the dashboard API, the CLI and the
 * export. Every price is LBank Spot (`PRICE_SOURCE`); the CMC price is labelled context. Exact
 * decimal strings throughout; nothing here writes.
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
      parts.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status) add('o.status = ?', q.status);
    if (q.eligibility) add('o.eligibility = ?', q.eligibility);
    if (q.stars) add('e.star_count = ?', q.stars);
    if (q.coverage === 'complete') parts.push('o.missing_bars = 0 AND o.covered_bars > 0');
    if (q.coverage === 'partial') parts.push('o.missing_bars > 0');
    if (q.from) add('o.t0 >= ?', new Date(q.from));
    if (q.to) add('o.t0 < ?', new Date(q.to));
    if (q.search) {
      const s = q.search.trim();
      if (/^\d+$/.test(s)) add('e.cmc_id = ?', Number(s));
      else
        add(
          '(e.symbol ILIKE ? OR e.name ILIKE $X OR o.pair_symbol ILIKE $X)',
          `%${s.replace(/[%_\\]/g, '\\$&')}%`,
        );
      parts[parts.length - 1] = parts.at(-1)!.replaceAll('$X', `$${params.length}`);
    }
    return { sql: parts.join(' AND '), params };
  }

  private select(where: string, tail: string) {
    return `SELECT o.*, e.cmc_id, e.symbol, e.name, e.slug, e.star_count, e.weighted_pass_points, e.score_complete,
                   e.cmc_price_usd::text AS cmc_price_usd,
                   o.entry_price::text AS entry_price, o.high_price::text AS high_price, o.low_price::text AS low_price,
                   o.max_rise_pct::text AS max_rise_pct, o.max_drop_pct::text AS max_drop_pct,
                   o.low_before_high_price::text AS low_before_high_price,
                   (SELECT count(*) FROM lbank_observation o2 JOIN lbank_obs_event e2 ON e2.id = o2.event_id
                     WHERE o2.provider_id = o.provider_id AND e2.cmc_id = e.cmc_id) AS coin_events,
                   (SELECT count(*) FROM lbank_observation o2 JOIN lbank_obs_event e2 ON e2.id = o2.event_id
                     WHERE o2.provider_id = o.provider_id AND e2.cmc_id = e.cmc_id AND o2.id <> o.id
                       AND o2.t0 < o.window_end AND o.t0 < o2.window_end) AS overlapping
              FROM lbank_observation o JOIN lbank_obs_event e ON e.id = o.event_id
             WHERE ${where} ${tail}`;
  }

  private toRow(r: RawRow): ObservationRow {
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
      signalAt: r.t0.toISOString(),
      windowEnd: r.window_end.toISOString(),
      cmcPriceUsd: plainText(r.cmc_price_usd)!,
      pair: { symbol: r.pair_symbol, quote: r.quote_asset, mapping: r.mapping_status },
      eligibility: r.eligibility,
      eligibilityLabel: ELIGIBILITY_LABEL[r.eligibility],
      spot: r.spot_status,
      spotTrading: r.spot_trading,
      futures: r.futures_status,
      entry:
        r.entry_at && r.entry_price !== null && r.entry_delay_ms !== null
          ? {
              at: r.entry_at.toISOString(),
              price: plainText(r.entry_price)!,
              delayMs: r.entry_delay_ms,
              stale: r.entry_stale,
              lastTradeAt: isoOf(r.entry_last_trade_at),
            }
          : null,
      high:
        r.high_price !== null && r.high_bar_at
          ? { price: plainText(r.high_price)!, barAt: r.high_bar_at.toISOString() }
          : null,
      low:
        r.low_price !== null && r.low_bar_at
          ? { price: plainText(r.low_price)!, barAt: r.low_bar_at.toISOString() }
          : null,
      maxRisePct: plainText(r.max_rise_pct),
      maxDropPct: plainText(r.max_drop_pct),
      lowBeforeHigh:
        r.low_before_high_price !== null && r.low_before_high_bar_at
          ? {
              price: plainText(r.low_before_high_price)!,
              barAt: r.low_before_high_bar_at.toISOString(),
            }
          : null,
      extremeOrder: r.extreme_order,
      coverage: {
        expectedBars: r.expected_bars,
        coveredBars: r.covered_bars,
        missingBars: r.missing_bars,
        tradedBars: r.traded_bars,
        observedThrough: isoOf(r.observed_through),
        complete: r.missing_bars === 0 && r.covered_bars > 0,
        startUnobservedMs: r.start_unobserved_ms,
        boundaryUnobservedMs: r.boundary_unobserved_ms,
        missingRanges: r.missing_ranges ?? [],
      },
      status: r.status,
      provisional: r.status !== 'FINAL',
      reasons: r.reasons,
      lastUpdateAt: isoOf(r.last_update_at),
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
    maxEntryDelayMs: number;
    maxEntryStalenessMs: number;
    cutover: CutoverStatus;
    lastRun: {
      id: string;
      trigger: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      notes: string[];
    } | null;
    lastSuccessfulRunAt: string | null;
    summary: ReturnType<typeof serializeSummary>;
  }> {
    const w = this.where(q);
    const rows = (await this.db.query(
      `SELECT o.id, e.cmc_id, e.star_count, o.status, o.eligibility, o.t0, o.window_end,
              o.max_rise_pct::text AS max_rise_pct, o.max_drop_pct::text AS max_drop_pct
         FROM lbank_observation o JOIN lbank_obs_event e ON e.id = o.event_id WHERE ${w.sql}`,
      w.params,
    )) as Array<{
      id: string;
      cmc_id: number;
      star_count: number;
      status: ObservationStatus;
      eligibility: EligibilityClass;
      t0: Date;
      window_end: Date;
      max_rise_pct: string | null;
      max_drop_pct: string | null;
    }>;
    const s = summarize(
      rows.map((r) => ({
        id: r.id,
        cmcId: r.cmc_id,
        stars: r.star_count,
        status: r.status,
        eligibility: r.eligibility,
        t0Ms: r.t0.getTime(),
        windowEndMs: r.window_end.getTime(),
        maxRisePct: dec(r.max_rise_pct),
        maxDropPct: dec(r.max_drop_pct),
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
    return {
      priceSource: PRICE_SOURCE,
      rulesVersion: OBSERVATION_RULES_VERSION,
      windowHours: WINDOW_HOURS,
      maxEntryDelayMs: MAX_ENTRY_DELAY_MS,
      maxEntryStalenessMs: MAX_ENTRY_STALENESS_MS,
      cutover: await this.cutover.status(this.providerId, new Date()),
      lastRun: last
        ? {
            id: last.id,
            trigger: last.trigger,
            status: last.status,
            startedAt: last.startedAt.toISOString(),
            finishedAt: isoOf(last.finishedAt),
            notes: last.notes,
          }
        : null,
      lastSuccessfulRunAt: ok ? (ok.finishedAt ?? ok.startedAt).toISOString() : null,
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
      `SELECT mapping_evidence, eligibility_evidence, eligibility_checked_at, pair_id FROM lbank_observation WHERE id = $1`,
      [id],
    )) as Array<{
      mapping_evidence: unknown;
      eligibility_evidence: unknown;
      eligibility_checked_at: Date | null;
      pair_id: number | null;
    }>;
    const pair = obs[0]?.pair_id
      ? ((
          (await this.db.query(
            `SELECT symbol, base, quote, first_bar_at, synced_until, last_fetch_at, last_fetch_status, last_error, unsupported_since FROM lbank_spot_pair WHERE id = $1`,
            [obs[0].pair_id],
          )) as Array<Record<string, unknown>>
        )[0] ?? null)
      : null;
    const results = await this.db
      .getRepository(ObservationResult)
      .find({ where: { observationId: id }, order: { resultVersion: 'ASC' } });
    const e = ev[0] ?? {};
    return {
      ...this.toRow(rows[0]),
      event: {
        detectedUtcDate: e.detected_utc_date,
        sourceBatchId: e.source_batch_id,
        sourceUpdatedAt: e.source_updated_at,
        rank: e.rank,
        pass: [e.pass_3d, e.pass_7d, e.pass_30d],
        multiples: [e.multiple_3d, e.multiple_7d, e.multiple_30d],
        currentVmc: e.current_vmc,
        weightedStrength: e.weighted_strength,
        rankingRulesetVersion: e.ranking_ruleset_version,
        rulesetVersion: e.ruleset_version,
        lbankPairs: e.lbank_pairs,
      },
      mappingEvidence: obs[0]?.mapping_evidence ?? null,
      eligibilityEvidence: obs[0]?.eligibility_evidence ?? null,
      eligibilityCheckedAt: isoOf(obs[0]?.eligibility_checked_at ?? null),
      pairState: pair,
      results: results.map((r) => ({
        version: r.resultVersion,
        status: r.status,
        eligibility: r.eligibility,
        reasons: r.reasons,
        rulesVersion: r.rulesVersion,
        maxRisePct: r.maxRisePct?.toFixed() ?? null,
        maxDropPct: r.maxDropPct?.toFixed() ?? null,
        seriesSha256: r.seriesSha256,
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
    const others = (await this.db.query(
      this.select(
        'o.provider_id = $1 AND e.cmc_id = $2 AND o.id <> $3 AND o.t0 < $4 AND $5 < o.window_end',
        'ORDER BY o.t0, o.id',
      ),
      [this.providerId, me.cmc_id, me.id, me.window_end, me.t0],
    )) as RawRow[];
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return {
      observation: this.toRow(me),
      coin: { cmcId: me.cmc_id, events: Number(me.coin_events) },
      overlaps: others.map((x) => {
        const start = Math.max(x.t0.getTime(), me.t0.getTime());
        const end = Math.min(x.window_end.getTime(), me.window_end.getTime());
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

  /** Every filtered observation as CSV (full precision; one row per event). */
  async csv(q: Omit<ObservationQuery, 'limit' | 'offset'>): Promise<string> {
    const header = [
      'observation_id',
      'event_id',
      'cmc_id',
      'symbol',
      'name',
      'stars',
      'weighted_pass_points',
      'signal_time_utc',
      'window_end_utc',
      'cmc_price_usd_context',
      'price_source',
      'lbank_pair',
      'quote_asset',
      'mapping_status',
      'eligibility',
      'spot_status',
      'spot_trading',
      'futures_status',
      'entry_time_utc',
      'entry_price',
      'entry_delay_ms',
      'entry_stale',
      'entry_last_trade_bar_utc',
      'highest_high',
      'highest_high_bar_utc',
      'lowest_low',
      'lowest_low_bar_utc',
      'max_rise_pct',
      'max_drop_pct',
      'low_before_high',
      'low_before_high_bar_utc',
      'extreme_order',
      'expected_bars',
      'covered_bars',
      'missing_bars',
      'traded_bars',
      'observed_through_utc',
      'start_unobserved_ms',
      'boundary_unobserved_ms',
      'missing_ranges',
      'status',
      'provisional',
      'reasons',
      'coin_events',
      'overlapping_events',
      'last_update_utc',
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
            r.signalAt,
            r.windowEnd,
            r.cmcPriceUsd,
            PRICE_SOURCE,
            r.pair.symbol,
            r.pair.quote,
            r.pair.mapping,
            r.eligibilityLabel,
            r.spot,
            r.spotTrading,
            r.futures,
            r.entry?.at,
            r.entry?.price,
            r.entry?.delayMs,
            r.entry?.stale,
            r.entry?.lastTradeAt,
            r.high?.price,
            r.high?.barAt,
            r.low?.price,
            r.low?.barAt,
            r.maxRisePct,
            r.maxDropPct,
            r.lowBeforeHigh?.price,
            r.lowBeforeHigh?.barAt,
            r.extremeOrder,
            r.coverage.expectedBars,
            r.coverage.coveredBars,
            r.coverage.missingBars,
            r.coverage.tradedBars,
            r.coverage.observedThrough,
            r.coverage.startUnobservedMs,
            r.coverage.boundaryUnobservedMs,
            r.coverage.missingRanges.map((x) => x.join('/')).join(' '),
            r.status,
            r.provisional,
            r.reasons.join(' '),
            r.coinEvents,
            r.overlapping,
            r.lastUpdateAt,
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
    return rows.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: isoOf(r.finishedAt),
      notes: r.notes,
      error: r.error,
    }));
  }

  /**
   * Routing check after the cutover: every published queue row at or after it is an observation
   * event, ignored as a duplicate key, or rejected with reasons; no event is missing its
   * observation; and no legacy event was created at or after the cutover.
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
    return {
      cutover,
      batchesAfterCutover: batches.length,
      batchesWithoutIntake: without,
      intakeRowsUnaccounted: unaccounted,
      eventsWithoutObservation: orphans,
      legacyEventsAfterCutover: legacyAfter,
      observationEventsBeforeCutover: newBefore,
      duplicateKeysAcrossTrackers: dupKeys,
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
      rise: statsJson(s.final.rise),
      drop: statsJson(s.final.drop),
      byStars: s.final.byStars.map((g) => ({
        ...g,
        rise: statsJson(g.rise),
        drop: statsJson(g.drop),
      })),
      byEligibility: s.final.byEligibility.map((g) => ({
        ...g,
        label: ELIGIBILITY_LABEL[g.key as EligibilityClass],
        rise: statsJson(g.rise),
        drop: statsJson(g.drop),
      })),
    },
  };
}

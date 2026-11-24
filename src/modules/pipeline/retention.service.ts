import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { HOUR_MS, addHours } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { AppStateService } from '../app-state/app-state.service.js';
import { ExportService } from '../exports/export.service.js';
import { RULES } from '../strategy/index.js';

const DAY_MS = 24 * HOUR_MS;
/** Bounded catch-up so one run never spends long on retention. */
const MAX_DAYS_PER_RUN = 3;

export interface RetentionReport {
  /** Snapshots older than RETENTION_SNAPSHOT_DAYS (when > 0). */
  deletedSnapshots: number;
  /** Snapshots past RETENTION_DETAIL_DAYS that no stored Review Queue row, forward-test event or benchmark needs. */
  prunedSnapshots: number;
  prunedDays: string[];
  /**
   * Rows stored under the earlier storage policy are still present: hourly retention leaves every
   * snapshot alone until the operator has backed up and run `storage:prune` once.
   */
  legacyPending: boolean;
  prunedExports: number;
}

/** Row count and on-disk size of one table (heap, indexes and TOAST). */
export interface TableSize {
  rows: number;
  bytes: number;
}

export interface PruneReport {
  mode: 'dry_run' | 'applied';
  detailCutoff: string;
  /** Scan rows outside the Review Queue (kept when a review or venue decision names them). */
  scanRows: { delete: number; keptReviewed: number; keep: number };
  /** Snapshots: outside ranks 1–1200, or past the detail window and needed by nothing kept. */
  snapshots: {
    deleteOutsideUniverse: number;
    deletePastDetailWindow: number;
    keepRecent: number;
    keepQueueInputs: number;
    keepForwardEvents: number;
    keepBenchmarks: number;
  };
  before: Record<'scan_result' | 'market_snapshot', TableSize>;
  after?: Record<'scan_result' | 'market_snapshot', TableSize>;
  vacuumed?: boolean;
  databaseBytes: { before: number; after?: number };
  seconds?: number;
}

export const utcDayStart = (d: Date) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
/** The first UTC day hourly retention has not processed yet (set only once no earlier rows remain). */
export const prunedUntilKey = (providerId: string) =>
  `retention.snapshotsPrunedUntil.${providerId}`;

/** A snapshot is outside the stored universe (D4): ranked above 1200, or unranked. */
const OUTSIDE = `(s.rank IS NULL OR s.rank < 1 OR s.rank > ${RULES.rankMax})`;
/** Scan rows a human record names (reviews and venue decisions are append-only): never pruned. */
const REVIEWED = `((r.batch_id, r.cmc_id) IN (
  SELECT v.batch_id, v.cmc_id FROM review v
  UNION ALL SELECT d.batch_id, d.cmc_id FROM venue_decision d WHERE d.batch_id IS NOT NULL))`;
/**
 * The snapshots that must stay, as sets built once per statement and joined by hash ($1 is the
 * provider id; `slots` narrows the hours read, a condition on `b.slot_time`):
 *  - `kept`: inputs of scan rows that stay stored (Review Queue rows, or rows a human record names);
 *  - `fwd`: the detection snapshots of forward-test and LBank observation events (provenance);
 *  - `bench`: the BTC/ETH benchmarks the coin agent reads.
 * Per-row correlated subqueries here took minutes on 2.5 M rows; these joins take seconds.
 */
const keepSets = (slots = 'TRUE') => `
  kept AS MATERIALIZED (
    SELECT DISTINCT b.slot_time, r.cmc_id::text AS pid
      FROM scan_result r JOIN crawl_batch b ON b.id = r.batch_id
     WHERE b.provider_id = $1 AND ${slots} AND (r.in_queue OR ${REVIEWED})),
  fwd AS MATERIALIZED (
    SELECT e.snapshot_id AS id FROM forward_event e WHERE e.snapshot_id IS NOT NULL
    UNION SELECT o.snapshot_id FROM lbank_obs_event o WHERE o.snapshot_id IS NOT NULL),
  bench AS MATERIALIZED (SELECT a.id FROM asset a WHERE a.is_benchmark)`;
const NOT_FORWARD = `NOT EXISTS (SELECT 1 FROM fwd WHERE fwd.id = s.id)`;
const NOT_BENCHMARK = `NOT EXISTS (SELECT 1 FROM bench WHERE bench.id = s.asset_id)`;
const NOT_KEPT = `NOT EXISTS (SELECT 1 FROM kept k WHERE k.slot_time = s.slot_time AND k.pid = s.provider_asset_id)`;

/**
 * Storage policy (operator decision D4, ADR-0008; docs/architecture.md#storage-and-retention):
 *  - collection stores snapshots of ranks 1–1200 only and the scan stores Review Queue rows only,
 *    so nothing outside the screen accumulates hour by hour;
 *  - after RETENTION_DETAIL_DAYS, a snapshot is kept only when a stored Review Queue row used it,
 *    a forward-test event references it, or it is a BTC/ETH benchmark; every other one is deleted
 *    (no daily thinning: daily baselines live in `daily_metric`);
 *  - RETENTION_SNAPSHOT_DAYS > 0 still deletes older snapshots outright, except forward-test ones;
 *  - export files older than EXPORT_RETENTION_DAYS are removed (the database keeps history).
 * Review Queue rows, reviews, decisions, daily rows, crawl batches, scan runs and the coin registry
 * are never pruned. Rows written under the earlier policy are removed only by `storage:prune`
 * (`pruneLegacy`), which the operator runs after a backup; until then hourly retention deletes no
 * snapshot at all.
 */
@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly exports: ExportService,
    private readonly state: AppStateService,
  ) {}

  async apply(providerId: string, now: Date): Promise<RetentionReport> {
    const report: RetentionReport = {
      deletedSnapshots: 0,
      prunedSnapshots: 0,
      prunedDays: [],
      legacyPending: false,
      prunedExports: 0,
    };
    const ready = await this.gate(providerId);
    report.legacyPending = !ready;
    if (ready && this.cfg.RETENTION_SNAPSHOT_DAYS > 0) {
      const cutoff = addHours(now, -24 * this.cfg.RETENTION_SNAPSHOT_DAYS);
      const [, deleted] = (await this.db.query(
        `DELETE FROM market_snapshot s WHERE s.provider_id = $1 AND s.slot_time < $2
           AND NOT EXISTS (SELECT 1 FROM forward_event e WHERE e.snapshot_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM lbank_obs_event o WHERE o.snapshot_id = s.id)`,
        [providerId, cutoff],
      )) as [unknown, number];
      report.deletedSnapshots = deleted;
    }
    if (ready && this.cfg.RETENTION_DETAIL_DAYS > 0)
      await this.pruneDays(providerId, this.detailCutoff(now), report);
    report.prunedExports = this.exports.prune(now);
    if (report.prunedSnapshots || report.deletedSnapshots || report.prunedExports)
      this.log.log(`retention: ${JSON.stringify(report)}`);
    return report;
  }

  /** Start of the oldest UTC day whose hourly detail is kept. */
  detailCutoff(now: Date): Date {
    return utcDayStart(new Date(now.getTime() - this.cfg.RETENTION_DETAIL_DAYS * DAY_MS));
  }

  /**
   * Whether hourly retention may delete snapshots. It opens by itself on a database without rows of
   * the earlier policy (a new install), and otherwise only once `storage:prune` has run: a deploy
   * never deletes earlier data before the operator's backup.
   */
  private async gate(providerId: string): Promise<boolean> {
    if ((await this.state.get<string>(prunedUntilKey(providerId))) !== undefined) return true;
    const [row] = (await this.db.query(
      `SELECT EXISTS (SELECT 1 FROM scan_result r WHERE r.provider_id = $1 AND NOT r.in_queue)
           OR EXISTS (SELECT 1 FROM market_snapshot s WHERE s.provider_id = $1 AND ${OUTSIDE}) AS legacy`,
      [providerId],
    )) as Array<{ legacy: boolean }>;
    if (row?.legacy) {
      this.log.warn(
        'retention: rows stored under the earlier storage policy remain; no snapshot is deleted until `storage:prune` runs (after a backup)',
      );
      return false;
    }
    const oldest = (await this.db.query(
      `SELECT min(slot_time) AS t FROM market_snapshot WHERE provider_id = $1`,
      [providerId],
    )) as Array<{ t: Date | null }>;
    await this.state.set(
      prunedUntilKey(providerId),
      utcDayStart(oldest[0]?.t ?? new Date()).toISOString(),
    );
    return true;
  }

  /** Prune whole UTC days older than `cutoff`, resuming from the persisted watermark. */
  private async pruneDays(providerId: string, cutoff: Date, report: RetentionReport) {
    const key = prunedUntilKey(providerId);
    const stored = await this.state.get<string>(key);
    if (stored === undefined) return;
    let day = new Date(stored);
    for (let n = 0; day < cutoff && n < MAX_DAYS_PER_RUN; n++) {
      report.prunedSnapshots += await this.pruneSnapshotDay(providerId, day);
      report.prunedDays.push(day.toISOString().slice(0, 10));
      day = new Date(day.getTime() + DAY_MS);
      await this.state.set(key, day.toISOString());
    }
  }

  /**
   * Delete one UTC day's snapshots except the ones still needed: inputs of a stored Review Queue
   * row, forward-test detection snapshots (immutable, referenced by `forward_event`) and the
   * BTC/ETH benchmarks the coin agent reads.
   */
  async pruneSnapshotDay(providerId: string, day: Date): Promise<number> {
    const start = utcDayStart(day);
    const end = new Date(start.getTime() + DAY_MS);
    const [, deleted] = (await this.db.query(
      `WITH ${keepSets('b.slot_time >= $2 AND b.slot_time < $3')}
       DELETE FROM market_snapshot s
        WHERE s.provider_id = $1 AND s.slot_time >= $2 AND s.slot_time < $3
          AND ${NOT_FORWARD} AND ${NOT_BENCHMARK} AND ${NOT_KEPT}`,
      [providerId, start, end],
    )) as [unknown, number];
    return deleted;
  }

  /**
   * One-time cleanup of rows stored under the earlier policy (CLI `storage:prune`; run under the
   * pipeline lease, after a backup). Deletes scan rows outside the Review Queue (unless a review or
   * venue decision names them), snapshots outside ranks 1–1200, and snapshots past the detail
   * window that nothing kept needs. Forward-test snapshots, Review Queue rows and their inputs,
   * benchmarks, daily rows, batches and the coin registry stay. Without `apply`, only counts.
   * Work is done one batch / slot at a time, so it can be interrupted and run again.
   */
  async pruneLegacy(
    providerId: string,
    now: Date,
    opts: { apply: boolean; vacuum?: boolean; onProgress?: (line: string) => void },
  ): Promise<PruneReport> {
    const started = Date.now();
    const say = opts.onProgress ?? (() => undefined);
    const cutoff = this.detailCutoff(now);
    const before = await this.tableSizes();
    const databaseBefore = await this.databaseBytes();

    const [scan] = (await this.db.query(
      `SELECT count(*) FILTER (WHERE NOT r.in_queue AND NOT ${REVIEWED})::int AS del,
              count(*) FILTER (WHERE NOT r.in_queue AND ${REVIEWED})::int AS reviewed,
              count(*) FILTER (WHERE r.in_queue)::int AS keep
         FROM scan_result r WHERE r.provider_id = $1`,
      [providerId],
    )) as Array<{ del: number; reviewed: number; keep: number }>;
    const [snap] = (await this.db.query(
      `WITH ${keepSets()}
       SELECT count(*) FILTER (WHERE x.k = 'outside')::int AS outside,
              count(*) FILTER (WHERE x.k = 'past')::int AS past,
              count(*) FILTER (WHERE x.k = 'recent')::int AS recent,
              count(*) FILTER (WHERE x.k = 'queue')::int AS queue,
              count(*) FILTER (WHERE x.k = 'forward')::int AS forward,
              count(*) FILTER (WHERE x.k = 'benchmark')::int AS benchmark
         FROM (SELECT CASE WHEN f.id IS NOT NULL THEN 'forward'
                           WHEN bn.id IS NOT NULL THEN 'benchmark'
                           WHEN ${OUTSIDE} THEN 'outside'
                           WHEN s.slot_time >= $2 THEN 'recent'
                           WHEN k.pid IS NOT NULL THEN 'queue'
                           ELSE 'past' END AS k
                 FROM market_snapshot s
                 LEFT JOIN fwd f ON f.id = s.id
                 LEFT JOIN bench bn ON bn.id = s.asset_id
                 LEFT JOIN kept k ON k.slot_time = s.slot_time AND k.pid = s.provider_asset_id
                WHERE s.provider_id = $1) x`,
      [providerId, cutoff],
    )) as Array<Record<'outside' | 'past' | 'recent' | 'queue' | 'forward' | 'benchmark', number>>;
    const report: PruneReport = {
      mode: opts.apply ? 'applied' : 'dry_run',
      detailCutoff: cutoff.toISOString(),
      scanRows: { delete: scan!.del, keptReviewed: scan!.reviewed, keep: scan!.keep },
      snapshots: {
        deleteOutsideUniverse: snap!.outside,
        deletePastDetailWindow: snap!.past,
        keepRecent: snap!.recent,
        keepQueueInputs: snap!.queue,
        keepForwardEvents: snap!.forward,
        keepBenchmarks: snap!.benchmark,
      },
      before,
      databaseBytes: { before: databaseBefore },
    };
    if (!opts.apply) return report;

    const batches = (await this.db.query(
      `SELECT DISTINCT r.batch_id AS id FROM scan_result r WHERE r.provider_id = $1 AND NOT r.in_queue`,
      [providerId],
    )) as Array<{ id: string }>;
    let deletedRows = 0;
    for (const [i, b] of batches.entries()) {
      const [, n] = (await this.db.query(
        `DELETE FROM scan_result r WHERE r.batch_id = $1 AND NOT r.in_queue AND NOT ${REVIEWED}`,
        [b.id],
      )) as [unknown, number];
      deletedRows += n;
      if ((i + 1) % 25 === 0 || i + 1 === batches.length)
        say(`scan_result: ${i + 1}/${batches.length} batches, ${deletedRows} rows deleted`);
    }

    const slots = (await this.db.query(
      `SELECT DISTINCT slot_time AS t FROM market_snapshot WHERE provider_id = $1 ORDER BY 1`,
      [providerId],
    )) as Array<{ t: Date }>;
    let deletedSnaps = 0;
    for (const [i, { t }] of slots.entries()) {
      // Inside the detail window only rows outside ranks 1–1200 go; older slots keep only what a
      // stored queue row, a forward-test event or a benchmark needs.
      const recent = t >= cutoff;
      const [, n] = (await this.db.query(
        `WITH ${keepSets('b.slot_time = $2')}
         DELETE FROM market_snapshot s
          WHERE s.provider_id = $1 AND s.slot_time = $2 AND ${NOT_FORWARD} AND ${NOT_BENCHMARK}
            AND ${recent ? OUTSIDE : `(${OUTSIDE} OR ${NOT_KEPT})`}`,
        [providerId, t],
      )) as [unknown, number];
      deletedSnaps += n;
      if ((i + 1) % 25 === 0 || i + 1 === slots.length)
        say(`market_snapshot: ${i + 1}/${slots.length} slots, ${deletedSnaps} rows deleted`);
    }
    // Every day before the cutoff is now in its final state: hourly retention continues from there.
    await this.state.set(prunedUntilKey(providerId), cutoff.toISOString());

    if (opts.vacuum) {
      for (const t of ['scan_result', 'market_snapshot']) {
        say(`VACUUM (FULL, ANALYZE) ${t}`);
        await this.db.query(`VACUUM (FULL, ANALYZE) ${t}`);
      }
      report.vacuumed = true;
    } else {
      for (const t of ['scan_result', 'market_snapshot']) await this.db.query(`ANALYZE ${t}`);
      report.vacuumed = false;
    }
    report.after = await this.tableSizes();
    report.databaseBytes.after = await this.databaseBytes();
    report.seconds = Math.round((Date.now() - started) / 1000);
    this.log.log(`storage:prune ${JSON.stringify(report)}`);
    return report;
  }

  private async tableSizes(): Promise<Record<'scan_result' | 'market_snapshot', TableSize>> {
    const out = {} as Record<'scan_result' | 'market_snapshot', TableSize>;
    for (const t of ['scan_result', 'market_snapshot'] as const) {
      const [r] = (await this.db.query(
        `SELECT (SELECT count(*) FROM ${t})::bigint AS rows, pg_total_relation_size('${t}')::bigint AS bytes`,
      )) as Array<{ rows: string; bytes: string }>;
      out[t] = { rows: Number(r!.rows), bytes: Number(r!.bytes) };
    }
    return out;
  }

  private async databaseBytes(): Promise<number> {
    const [r] = (await this.db.query(
      `SELECT pg_database_size(current_database())::bigint AS b`,
    )) as Array<{ b: string }>;
    return Number(r!.b);
  }
}

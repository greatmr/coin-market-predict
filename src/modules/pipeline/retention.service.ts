import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, LessThan } from 'typeorm';

import { HOUR_MS, addHours } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { AppStateService } from '../app-state/app-state.service.js';
import { ExportService } from '../exports/export.service.js';
import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';
import { REASON, RULES } from '../strategy/index.js';

const DAY_MS = 24 * HOUR_MS;
/** Rows of a coin within this distance of any hour it was inside the Tier 1 band are always kept. */
export const UNIVERSE_GUARD_HOURS = 72;
/** Bounded catch-up so one run never spends long on retention. */
const MAX_DAYS_PER_RUN = 3;

export interface RetentionReport {
  deletedSnapshots: number;
  thinnedSnapshots: number;
  thinnedScanRows: number;
  thinnedDays: string[];
  prunedExports: number;
}

export const utcDayStart = (d: Date) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
const watermarkKey = (providerId: string) => `retention.detailThinnedUntil.${providerId}`;

/**
 * Storage policy (docs/architecture.md#storage-and-retention, assumption A20):
 *  - every collected coin keeps hourly raw snapshots for RETENTION_DETAIL_DAYS;
 *  - after that, coins that were outside the Tier 1 band (rank 101–1200, or unranked with cap ≥
 *    $15M) for the whole day ±72 h keep only their first snapshot of each UTC day — a genuine
 *    observation, never an aggregate; band coins keep every hour;
 *  - scan rows excluded only by rank/cap keep the first batch of each UTC day; every other scan
 *    row (eligible, needs review, excluded for any other reason) is kept;
 *  - export files older than EXPORT_RETENTION_DAYS are removed (the database keeps history);
 *  - RETENTION_SNAPSHOT_DAYS > 0 still deletes snapshots older than that (0 keeps all).
 * Reviews, decisions, daily rows and crawl batches are never pruned.
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
      thinnedSnapshots: 0,
      thinnedScanRows: 0,
      thinnedDays: [],
      prunedExports: 0,
    };
    if (this.cfg.RETENTION_SNAPSHOT_DAYS > 0) {
      const cutoff = addHours(now, -24 * this.cfg.RETENTION_SNAPSHOT_DAYS);
      report.deletedSnapshots =
        (await this.db.getRepository(MarketSnapshot).delete({ slotTime: LessThan(cutoff) }))
          .affected ?? 0;
    }
    if (this.cfg.RETENTION_DETAIL_DAYS > 0)
      await this.thin(
        providerId,
        utcDayStart(new Date(now.getTime() - this.cfg.RETENTION_DETAIL_DAYS * DAY_MS)),
        report,
      );
    report.prunedExports = this.exports.prune(now);
    if (
      report.thinnedSnapshots ||
      report.deletedSnapshots ||
      report.thinnedScanRows ||
      report.prunedExports
    )
      this.log.log(`retention: ${JSON.stringify(report)}`);
    return report;
  }

  /** Thin whole UTC days older than `cutoff`, resuming from a persisted watermark. */
  private async thin(providerId: string, cutoff: Date, report: RetentionReport) {
    const key = watermarkKey(providerId);
    const stored = await this.state.get<string>(key);
    let day: Date;
    if (stored !== undefined) day = new Date(stored);
    else {
      const oldest = await this.db.getRepository(MarketSnapshot).findOne({
        where: { providerId },
        order: { slotTime: 'ASC' },
        select: { id: true, slotTime: true },
      });
      if (!oldest) return;
      day = utcDayStart(oldest.slotTime);
    }
    for (let n = 0; day < cutoff && n < MAX_DAYS_PER_RUN; n++) {
      report.thinnedSnapshots += await this.thinDay(providerId, day);
      report.thinnedScanRows += await this.thinScanDay(providerId, day);
      report.thinnedDays.push(day.toISOString().slice(0, 10));
      day = new Date(day.getTime() + DAY_MS);
      await this.state.set(key, day.toISOString());
    }
  }

  /** Delete one day's hourly rows of coins outside the Tier 1 band except each coin's first snapshot of that day. */
  async thinDay(providerId: string, day: Date): Promise<number> {
    const start = utcDayStart(day);
    const end = new Date(start.getTime() + DAY_MS);
    const guardFrom = addHours(start, -UNIVERSE_GUARD_HOURS);
    const guardTo = addHours(end, UNIVERSE_GUARD_HOURS);
    const [, deleted] = (await this.db.query(
      `WITH qualified AS (
         SELECT DISTINCT u.asset_id
           FROM market_snapshot u
          WHERE u.provider_id = $1 AND u.slot_time >= $2 AND u.slot_time < $3
            AND ((u.rank BETWEEN $4 AND $5) OR (u.rank IS NULL AND u.market_cap >= $6::numeric))
       ), first_of_day AS (
         SELECT DISTINCT ON (f.asset_id) f.id
           FROM market_snapshot f
          WHERE f.provider_id = $1 AND f.slot_time >= $7 AND f.slot_time < $8
          ORDER BY f.asset_id, f.slot_time ASC
       )
       DELETE FROM market_snapshot s
        WHERE s.provider_id = $1 AND s.slot_time >= $7 AND s.slot_time < $8
          AND NOT EXISTS (SELECT 1 FROM qualified q WHERE q.asset_id = s.asset_id)
          AND NOT EXISTS (SELECT 1 FROM first_of_day k WHERE k.id = s.id)`,
      [
        providerId,
        guardFrom,
        guardTo,
        RULES.rankMin,
        RULES.rankMax,
        RULES.minMarketCapUsd,
        start,
        end,
      ],
    )) as [unknown, number];
    return deleted;
  }

  /** Scan rows excluded only by rank/cap keep the first batch of the UTC day. */
  async thinScanDay(providerId: string, day: Date): Promise<number> {
    const start = utcDayStart(day);
    const end = new Date(start.getTime() + DAY_MS);
    const farOutside = [REASON.rankOutOfRange, REASON.capBelowMin];
    const [, deleted] = (await this.db.query(
      `WITH first_batch AS (
         SELECT id FROM crawl_batch WHERE provider_id = $1 AND slot_time >= $2 AND slot_time < $3 ORDER BY slot_time ASC LIMIT 1
       )
       DELETE FROM scan_result r USING crawl_batch b
        WHERE r.batch_id = b.id AND b.provider_id = $1 AND b.slot_time >= $2 AND b.slot_time < $3
          AND b.id NOT IN (SELECT id FROM first_batch)
          AND r.eligibility_status = 'EXCLUDED'
          AND r.eligibility_reasons <@ $4::text[]`,
      [providerId, start, end, farOutside],
    )) as [unknown, number];
    return deleted;
  }
}

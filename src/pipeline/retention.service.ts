import { Inject, Injectable, Logger } from "@nestjs/common";
import { addHours, HOUR_MS } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ExportService } from "../tier1/export.service.js";
import { REASON, RULES } from "../tier1/constants.js";

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
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly exports: ExportService,
  ) {}

  async apply(providerId: string, now: Date): Promise<RetentionReport> {
    const report: RetentionReport = { deletedSnapshots: 0, thinnedSnapshots: 0, thinnedScanRows: 0, thinnedDays: [], prunedExports: 0 };
    if (this.cfg.RETENTION_SNAPSHOT_DAYS > 0) {
      const cutoff = addHours(now, -24 * this.cfg.RETENTION_SNAPSHOT_DAYS);
      report.deletedSnapshots = (await this.prisma.marketSnapshot.deleteMany({ where: { slotTime: { lt: cutoff } } })).count;
    }
    if (this.cfg.RETENTION_DETAIL_DAYS > 0) await this.thin(providerId, utcDayStart(new Date(now.getTime() - this.cfg.RETENTION_DETAIL_DAYS * DAY_MS)), report);
    report.prunedExports = this.exports.prune(now);
    if (report.thinnedSnapshots || report.deletedSnapshots || report.thinnedScanRows || report.prunedExports) this.log.log(`retention: ${JSON.stringify(report)}`);
    return report;
  }

  /** Thin whole UTC days older than `cutoff`, resuming from a persisted watermark. */
  private async thin(providerId: string, cutoff: Date, report: RetentionReport) {
    const key = watermarkKey(providerId);
    const state = await this.prisma.appState.findUnique({ where: { key } });
    let day: Date;
    if (state) day = new Date(state.value as string);
    else {
      const oldest = await this.prisma.marketSnapshot.findFirst({ where: { providerId }, orderBy: { slotTime: "asc" }, select: { slotTime: true } });
      if (!oldest) return;
      day = utcDayStart(oldest.slotTime);
    }
    for (let n = 0; day < cutoff && n < MAX_DAYS_PER_RUN; n++) {
      report.thinnedSnapshots += await this.thinDay(providerId, day);
      report.thinnedScanRows += await this.thinScanDay(providerId, day);
      report.thinnedDays.push(day.toISOString().slice(0, 10));
      day = new Date(day.getTime() + DAY_MS);
      await this.prisma.appState.upsert({ where: { key }, create: { key, value: day.toISOString() }, update: { value: day.toISOString() } });
    }
  }

  /** Delete one day's hourly rows of coins outside the Tier 1 band except each coin's first snapshot of that day. */
  async thinDay(providerId: string, day: Date): Promise<number> {
    const start = utcDayStart(day);
    const end = new Date(start.getTime() + DAY_MS);
    const guardFrom = addHours(start, -UNIVERSE_GUARD_HOURS);
    const guardTo = addHours(end, UNIVERSE_GUARD_HOURS);
    return this.prisma.$executeRaw`
      WITH qualified AS (
        SELECT DISTINCT u."assetId"
        FROM "MarketSnapshot" u
        WHERE u."providerId" = ${providerId} AND u."slotTime" >= ${guardFrom} AND u."slotTime" < ${guardTo}
          AND ((u.rank BETWEEN ${RULES.rankMin} AND ${RULES.rankMax}) OR (u.rank IS NULL AND u."marketCap" >= ${RULES.minMarketCapUsd}::numeric))
      ), first_of_day AS (
        SELECT DISTINCT ON (f."assetId") f.id
        FROM "MarketSnapshot" f
        WHERE f."providerId" = ${providerId} AND f."slotTime" >= ${start} AND f."slotTime" < ${end}
        ORDER BY f."assetId", f."slotTime" ASC
      )
      DELETE FROM "MarketSnapshot" s
      WHERE s."providerId" = ${providerId} AND s."slotTime" >= ${start} AND s."slotTime" < ${end}
        AND NOT EXISTS (SELECT 1 FROM qualified q WHERE q."assetId" = s."assetId")
        AND NOT EXISTS (SELECT 1 FROM first_of_day k WHERE k.id = s.id)`;
  }

  /** Scan rows excluded only by rank/cap keep the first batch of the UTC day. */
  async thinScanDay(providerId: string, day: Date): Promise<number> {
    const start = utcDayStart(day);
    const end = new Date(start.getTime() + DAY_MS);
    const farOutside = [REASON.rankOutOfRange, REASON.capBelowMin];
    return this.prisma.$executeRaw`
      WITH first_batch AS (
        SELECT id FROM "CrawlBatch" WHERE "providerId" = ${providerId} AND "slotTime" >= ${start} AND "slotTime" < ${end} ORDER BY "slotTime" ASC LIMIT 1
      )
      DELETE FROM "ScanResult" r USING "CrawlBatch" b
      WHERE r."batchId" = b.id AND b."providerId" = ${providerId} AND b."slotTime" >= ${start} AND b."slotTime" < ${end}
        AND b.id NOT IN (SELECT id FROM first_batch)
        AND r."eligibilityStatus" = 'EXCLUDED'
        AND r."eligibilityReasons" <@ ${farOutside}::text[]`;
  }
}

import { Inject, Injectable, Logger } from "@nestjs/common";
import { addHours, HOUR_MS } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EXCLUDED_CLASSES } from "../screening/universe.js";

const DAY_MS = 24 * HOUR_MS;
/** Rows of a coin within this distance of any hour it qualified for the strategy are always kept. */
export const UNIVERSE_GUARD_HOURS = 72;
/** Bounded catch-up so one run never spends long on retention. */
const MAX_DAYS_PER_RUN = 3;

export interface RetentionReport {
  deletedSnapshots: number;
  deletedFeatures: number;
  thinnedSnapshots: number;
  thinnedDays: string[];
  prunedFeatures: number;
  prunedScreening: number;
}

export const utcDayStart = (d: Date) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
const watermarkKey = (providerId: string) => `retention.detailThinnedUntil.${providerId}`;

/**
 * Storage policy (docs/architecture.md#storage-and-retention):
 *  - every collected coin keeps hourly raw snapshots for RETENTION_DETAIL_DAYS;
 *  - after that, coins that were outside the strategy universe for the whole day ±72h keep only
 *    their first snapshot of each UTC day (a genuine observation, never an aggregate); coins that
 *    qualified at any point keep every hour so look-backs and outcomes stay reproducible;
 *  - recomputable per-coin feature and non-shortlisted screening rows are pruned after the same window;
 *  - RETENTION_SNAPSHOT_DAYS > 0 still deletes everything older (0 keeps all).
 * Signals, paper positions, runs and VMC data are never touched here.
 */
@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async apply(providerId: string, now: Date): Promise<RetentionReport> {
    const report: RetentionReport = { deletedSnapshots: 0, deletedFeatures: 0, thinnedSnapshots: 0, thinnedDays: [], prunedFeatures: 0, prunedScreening: 0 };
    if (this.cfg.RETENTION_SNAPSHOT_DAYS > 0) {
      const cutoff = addHours(now, -24 * this.cfg.RETENTION_SNAPSHOT_DAYS);
      report.deletedSnapshots = (await this.prisma.marketSnapshot.deleteMany({ where: { slotTime: { lt: cutoff } } })).count;
      report.deletedFeatures = (await this.prisma.featureValue.deleteMany({ where: { slotTime: { lt: cutoff } } })).count;
    }
    if (this.cfg.RETENTION_DETAIL_DAYS > 0) {
      const cutoff = utcDayStart(new Date(now.getTime() - this.cfg.RETENTION_DETAIL_DAYS * DAY_MS));
      report.prunedFeatures = (await this.prisma.featureValue.deleteMany({ where: { slotTime: { lt: cutoff } } })).count;
      report.prunedScreening = (await this.prisma.screeningResult.deleteMany({ where: { slotTime: { lt: cutoff }, shortlisted: false } })).count;
      await this.thin(providerId, cutoff, report);
    }
    if (report.thinnedSnapshots || report.deletedSnapshots || report.prunedFeatures || report.prunedScreening) this.log.log(`retention: ${JSON.stringify(report)}`);
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
      report.thinnedDays.push(day.toISOString().slice(0, 10));
      day = new Date(day.getTime() + DAY_MS);
      await this.prisma.appState.upsert({ where: { key }, create: { key, value: day.toISOString() }, update: { value: day.toISOString() } });
    }
  }

  /** Delete one day's hourly rows of tail coins except each coin's first snapshot of that day. */
  async thinDay(providerId: string, day: Date): Promise<number> {
    const start = utcDayStart(day);
    const end = new Date(start.getTime() + DAY_MS);
    const guardFrom = addHours(start, -UNIVERSE_GUARD_HOURS);
    const guardTo = addHours(end, UNIVERSE_GUARD_HOURS);
    const excluded = [...EXCLUDED_CLASSES];
    return this.prisma.$executeRaw`
      WITH qualified AS (
        SELECT DISTINCT u."assetId"
        FROM "MarketSnapshot" u JOIN "Asset" a ON a.id = u."assetId"
        WHERE u."providerId" = ${providerId} AND u."slotTime" >= ${guardFrom} AND u."slotTime" < ${guardTo}
          AND (a."isBenchmark" OR (a."assetClass" <> ALL(${excluded}::text[])
               AND u."marketCap" >= ${this.cfg.MIN_MARKET_CAP_USD}::numeric AND u."volumeRolling24h" >= ${this.cfg.MIN_VOLUME_24H_USD}::numeric))
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
}

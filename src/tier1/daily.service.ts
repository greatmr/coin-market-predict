import { Inject, Injectable, Logger } from "@nestjs/common";
import { dec, forStorage, sha256 } from "../common/decimal.js";
import { addDays, isoDate, parseIsoDate } from "../common/dates.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { stopsCrawl } from "../sources/coinmarketcap-web/errors.js";
import { TIER1_SOURCE, type DailySourceRow, type Tier1Source } from "../sources/types.js";
import { spendableRequests } from "./budget.js";
import { dailyRatio } from "./vmc.js";

export interface DailyRefreshReport {
  status: "not_supported" | "not_needed" | "completed" | "partial";
  asOfDate: string;
  latestCompletedDate: string;
  candidates: number;
  /** Candidates without a row for the latest completed day that are due for a request. */
  due: number;
  attempted: number;
  fetched: number;
  failed: number;
  rows: { inserted: number; revised: number; unchanged: number; invalid: number };
  /** Candidates still missing the latest completed day after this run. */
  remaining: number;
  stoppedBy: "max_assets" | "time_budget" | "request_budget_reserve" | "source_unavailable" | null;
  notes: string[];
}

export interface UpsertMeta {
  source: string;
  params: Record<string, string>;
  responseSha256: string | null;
  retrievedAt: Date;
  batchId: string | null;
}

/**
 * Completed UTC daily rows (PDF p.11) from the existing crawler's history route. One request per
 * candidate covers the whole look-back window, so later source revisions are picked up on the next
 * refresh; every change becomes a new revision and the effective row points at it.
 */
@Injectable()
export class DailyService {
  private readonly log = new Logger(DailyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TIER1_SOURCE) private readonly source: Tier1Source | null,
  ) {}

  /** Insert a revision only when the content differs from the effective row (a retry is not a revision). */
  async upsertRows(providerId: string, rows: DailySourceRow[], meta: UpsertMeta): Promise<DailyRefreshReport["rows"]> {
    const counts = { inserted: 0, revised: 0, unchanged: 0, invalid: 0 };
    if (!rows.length) return counts;
    const cmcId = rows[0]!.cmcId;
    const prepared = rows.map((r) => {
      const v = dailyRatio(dec(r.volume), dec(r.marketCap));
      const invalidReasons = [...r.invalidReasons, ...v.reasons];
      const valid = invalidReasons.length === 0;
      // Values, not their text: "1.50" and "1.5" from the source are the same row, not a revision.
      const norm = (v: string | null) => dec(v)?.toFixed() ?? null;
      const contentHash = sha256(JSON.stringify([norm(r.volume), norm(r.marketCap), norm(r.open), norm(r.high), norm(r.low), norm(r.close), valid, invalidReasons, r.sourceCloseAt?.toISOString() ?? null]));
      return { r, valid, invalidReasons, ratio: valid ? v.ratio : null, contentHash };
    });
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.dailyMetric.findMany({ where: { providerId, cmcId, dateUtc: { in: prepared.map((p) => parseIsoDate(p.r.dateUtc)) } } });
      const revisions = new Map((await tx.dailyMetricRevision.findMany({ where: { id: { in: current.map((c) => c.revisionId) } }, select: { id: true, contentHash: true } })).map((x) => [x.id, x.contentHash]));
      const byDate = new Map(current.map((c) => [isoDate(c.dateUtc), c]));
      const changed: Array<(typeof prepared)[number] & { revision: number; isNew: boolean }> = [];
      for (const p of prepared) {
        if (!p.valid) counts.invalid++;
        const cur = byDate.get(p.r.dateUtc);
        if (cur && revisions.get(cur.revisionId) === p.contentHash) counts.unchanged++;
        else changed.push({ ...p, revision: (cur?.revision ?? 0) + 1, isNew: !cur });
      }
      if (!changed.length) return;
      const created = await tx.dailyMetricRevision.createManyAndReturn({
        data: changed.map((p) => ({
          providerId, cmcId, dateUtc: parseIsoDate(p.r.dateUtc), revision: p.revision, revisionReason: p.isNew ? "first" : "source_revision",
          volumeUsd: p.r.volume, marketCapUsd: p.r.marketCap, openUsd: p.r.open, highUsd: p.r.high, lowUsd: p.r.low, closeUsd: p.r.close,
          valid: p.valid, invalidReasons: p.invalidReasons, periodStart: p.r.periodStart, periodEnd: p.r.periodEnd, sourceCloseAt: p.r.sourceCloseAt,
          sourceFields: p.r.sourceFields as never, source: meta.source, sourceParams: meta.params, responseSha256: meta.responseSha256, contentHash: p.contentHash,
          retrievedAt: meta.retrievedAt, batchId: meta.batchId,
        })),
        select: { id: true, dateUtc: true },
      });
      const idByDate = new Map(created.map((c) => [isoDate(c.dateUtc), c.id]));
      const effective = (p: (typeof changed)[number]) => ({ revisionId: idByDate.get(p.r.dateUtc)!, revision: p.revision, volumeUsd: p.r.volume, marketCapUsd: p.r.marketCap, closeUsd: p.r.close, vmc: forStorage(p.ratio), valid: p.valid, invalidReasons: p.invalidReasons, sourceCloseAt: p.r.sourceCloseAt, retrievedAt: meta.retrievedAt, source: meta.source });
      const fresh = changed.filter((p) => p.isNew);
      if (fresh.length) await tx.dailyMetric.createMany({ data: fresh.map((p) => ({ providerId, cmcId, dateUtc: parseIsoDate(p.r.dateUtc), ...effective(p) })) });
      for (const p of changed.filter((x) => !x.isNew)) {
        await tx.dailyMetric.update({ where: { providerId_cmcId_dateUtc: { providerId, cmcId, dateUtc: parseIsoDate(p.r.dateUtc) } }, data: effective(p) });
      }
      counts.inserted += fresh.length;
      counts.revised += changed.length - fresh.length;
    }, { timeout: 60_000 });
    return counts;
  }

  /**
   * Refresh daily rows for the batch's candidates that lack the latest completed day (T−1).
   * Ordered by the caller (most relevant first); bounded by assets, minutes and the request-budget
   * reserve; a candidate whose T−1 was not returned is retried after TIER1_DAILY_RETRY_HOURS.
   */
  async refresh(providerId: string, batch: { id: string; crawledAt: Date }, candidates: Array<{ cmcId: number; slug: string | null }>): Promise<DailyRefreshReport> {
    const asOfDate = isoDate(batch.crawledAt);
    const latest = addDays(asOfDate, -1);
    const from = addDays(asOfDate, -this.cfg.TIER1_DAILY_LOOKBACK_DAYS);
    const report: DailyRefreshReport = { status: "not_needed", asOfDate, latestCompletedDate: latest, candidates: candidates.length, due: 0, attempted: 0, fetched: 0, failed: 0, rows: { inserted: 0, revised: 0, unchanged: 0, invalid: 0 }, remaining: 0, stoppedBy: null, notes: [] };
    if (!this.source || this.source.providerId !== providerId) return { ...report, status: "not_supported", remaining: candidates.length, notes: ["this data source supplies no daily history: windows stay N/A"] };
    const ids = candidates.map((c) => c.cmcId);
    const have = new Set((await this.prisma.dailyMetric.findMany({ where: { providerId, cmcId: { in: ids }, dateUtc: parseIsoDate(latest) }, select: { cmcId: true } })).map((r) => r.cmcId));
    const states = new Map((await this.prisma.dailyFetchState.findMany({ where: { providerId, cmcId: { in: ids } } })).map((s) => [s.cmcId, s]));
    const now = new Date();
    const retryAfter = now.getTime() - this.cfg.TIER1_DAILY_RETRY_HOURS * 3_600_000;
    const due = candidates.filter((c) => {
      if (have.has(c.cmcId)) return false;
      const s = states.get(c.cmcId);
      // Already asked today for T−1 and it was not there: wait before asking again.
      return !s || isoDate(s.lastAttemptAt) !== asOfDate || s.lastAttemptAt.getTime() <= retryAfter;
    });
    report.due = due.length;
    if (!due.length) return { ...report, remaining: candidates.length - have.size };

    const deadline = Date.now() + this.cfg.TIER1_DAILY_MAX_MINUTES * 60_000;
    let allowance = await spendableRequests(this.prisma, this.cfg, providerId, now);
    let consecutiveFailures = 0;
    for (const c of due) {
      if (report.attempted >= this.cfg.TIER1_DAILY_MAX_ASSETS_PER_RUN) { report.stoppedBy = "max_assets"; break; }
      if (Date.now() >= deadline) { report.stoppedBy = "time_budget"; break; }
      if (report.attempted > 0 && report.attempted % 25 === 0) allowance = await spendableRequests(this.prisma, this.cfg, providerId);
      if (allowance <= 0) { report.stoppedBy = "request_budget_reserve"; break; }
      report.attempted++;
      allowance--;
      try {
        const r = await this.source.dailyHistory(c, from, latest, batch.crawledAt);
        const counts = await this.upsertRows(providerId, r.rows, { source: r.source, params: r.params, responseSha256: r.responseSha256, retrievedAt: r.retrievedAt, batchId: batch.id });
        for (const k of Object.keys(counts) as Array<keyof typeof counts>) report.rows[k] += counts[k];
        const newest = r.rows.at(-1)?.dateUtc ?? null;
        await this.saveState(providerId, c.cmcId, { lastAttemptAt: now, lastSuccessAt: now, lastStatus: newest === latest ? "ok" : r.rows.length ? "partial" : "no_data", lastError: null, rowsReturned: r.rows.length, latestDateReturned: newest ? parseIsoDate(newest) : null });
        report.fetched++;
        consecutiveFailures = 0;
      } catch (err) {
        report.failed++;
        const message = redact(err).slice(0, 300);
        await this.saveState(providerId, c.cmcId, { lastAttemptAt: now, lastStatus: "failed", lastError: message, rowsReturned: 0 });
        if (report.failed <= 5) report.notes.push(`CMC id ${c.cmcId}: ${message}`);
        if (stopsCrawl(err) || ++consecutiveFailures >= 5) {
          report.stoppedBy = "source_unavailable";
          report.notes.push(`daily refresh stopped: ${message}`);
          break;
        }
      }
    }
    const nowHave = await this.prisma.dailyMetric.count({ where: { providerId, cmcId: { in: ids }, dateUtc: parseIsoDate(latest) } });
    report.remaining = candidates.length - nowHave;
    report.status = report.remaining === 0 ? "completed" : "partial";
    report.notes.push(`daily rows: ${report.fetched}/${report.due} due candidates refreshed (${report.rows.inserted} new, ${report.rows.revised} revised); ${report.remaining} still lack ${latest}`);
    this.log.log(report.notes.at(-1)!);
    return report;
  }

  private async saveState(providerId: string, cmcId: number, s: { lastAttemptAt: Date; lastSuccessAt?: Date; lastStatus: string; lastError: string | null; rowsReturned: number; latestDateReturned?: Date | null }) {
    await this.prisma.dailyFetchState.upsert({ where: { providerId_cmcId: { providerId, cmcId } }, create: { providerId, cmcId, ...s }, update: s });
  }
}

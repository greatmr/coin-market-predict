import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { stopsCrawl } from "../sources/coinmarketcap-web/errors.js";
import { TIER1_SOURCE, type Tier1Source } from "../sources/types.js";
import { spendableRequests } from "./budget.js";
import { LBANK } from "./constants.js";
import type { VenuePair } from "./lbank.js";

export interface LbankCrawlReport {
  /** REUSED = the stored list is younger than LBANK_PAIRS_REFRESH_DAYS, nothing was fetched. */
  status: "COMPLETE" | "INCOMPLETE" | "FAILED" | "SKIPPED" | "REUSED";
  /** The crawl that was fetched now, or the stored list that was reused. */
  crawlId: string | null;
  pairs: number;
  expected: number | null;
  listedEvents: number;
  absentEvents: number;
  notes: string[];
  /** A COMPLETE list no older than LBANK_PAIRS_MAX_AGE_DAYS exists after this call. */
  usable: boolean;
  /** Fetch time of the newest COMPLETE list and when it is next refreshed automatically. */
  listFetchedAt: string | null;
  nextRefreshAt: string | null;
}

export interface LbankListStatus {
  crawlId: string;
  fetchedAt: string;
  pairs: number;
  expected: number | null;
  ageDays: number;
  nextRefreshAt: string;
  staleAt: string;
  stale: boolean;
  trigger: string | null;
  lastAttempt: { at: string; status: string; error: string | null } | null;
}

export interface VenueRefreshReport {
  candidates: number;
  due: number;
  attempted: number;
  fetched: number;
  failed: number;
  stoppedBy: "max_assets" | "time_budget" | "request_budget_reserve" | "source_unavailable" | null;
  notes: string[];
}

/**
 * Venue inputs collected by the existing CMC website crawler (gaps G6, G7): LBank Spot pairs
 * for every batch and CMC Markets spot pairs for review candidates. Every crawl keeps the
 * normalized pair rows it produced, so scans and reviews can show the exact evidence.
 */
@Injectable()
export class VenuesService {
  private readonly log = new Logger(VenuesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TIER1_SOURCE) private readonly source: Tier1Source | null,
  ) {}

  get available() {
    return this.source !== null;
  }

  private get refreshMs() {
    return this.cfg.LBANK_PAIRS_REFRESH_DAYS * 86_400_000;
  }

  private get maxAgeMs() {
    return this.cfg.LBANK_PAIRS_MAX_AGE_DAYS * 86_400_000;
  }

  /** Newest COMPLETE LBank Spot markets list (the one scans use). */
  latestLbankList(providerId: string) {
    return this.prisma.venueCrawl.findFirst({ where: { providerId, kind: "lbank_spot_pairs", status: "COMPLETE" }, orderBy: { finishedAt: "desc" } });
  }

  /** Age, next automatic refresh and the last attempt of the stored LBank list (dashboard, API). */
  async lbankListStatus(providerId: string, now = new Date()): Promise<LbankListStatus | null> {
    const [list, attempt] = await Promise.all([
      this.latestLbankList(providerId),
      this.prisma.venueCrawl.findFirst({ where: { providerId, kind: "lbank_spot_pairs" }, orderBy: { finishedAt: "desc" } }),
    ]);
    if (!list) return null;
    const summary = (list.summary ?? {}) as { trigger?: string };
    return {
      crawlId: list.id,
      fetchedAt: list.finishedAt.toISOString(),
      pairs: list.fetchedCount,
      expected: list.expectedCount,
      ageDays: Math.round(((now.getTime() - list.finishedAt.getTime()) / 86_400_000) * 100) / 100,
      nextRefreshAt: new Date(list.finishedAt.getTime() + this.refreshMs).toISOString(),
      staleAt: new Date(list.finishedAt.getTime() + this.maxAgeMs).toISOString(),
      stale: now.getTime() - list.finishedAt.getTime() > this.maxAgeMs,
      trigger: summary.trigger ?? null,
      lastAttempt: attempt && attempt.id !== list.id ? { at: attempt.finishedAt.toISOString(), status: attempt.status, error: attempt.error } : null,
    };
  }

  /**
   * LBank Spot pairs (stage `lbank`, and the manual refresh). The list is fetched once and reused
   * until it is LBANK_PAIRS_REFRESH_DAYS old (operator decision D2); `force` fetches it now. A
   * failed or incomplete refresh is recorded and the previous COMPLETE list stays in use until it
   * is LBANK_PAIRS_MAX_AGE_DAYS old. Never throws.
   */
  async ensureLbankPairs(providerId: string, batchId: string | null, at: Date, opts: { force?: boolean; trigger?: "schedule" | "manual" } = {}): Promise<LbankCrawlReport> {
    const base = { listedEvents: 0, absentEvents: 0 };
    if (!this.source || this.source.providerId !== providerId) {
      return { ...base, status: "SKIPPED", crawlId: null, pairs: 0, expected: null, usable: false, listFetchedAt: null, nextRefreshAt: null, notes: ["this data source supplies no LBank pair feed: LBank status stays UNKNOWN"] };
    }
    const previous = await this.latestLbankList(providerId);
    const describe = (list: { finishedAt: Date } | null) => ({
      usable: !!list && at.getTime() - list.finishedAt.getTime() <= this.maxAgeMs,
      listFetchedAt: list?.finishedAt.toISOString() ?? null,
      nextRefreshAt: list ? new Date(list.finishedAt.getTime() + this.refreshMs).toISOString() : null,
    });
    if (!opts.force && previous && at.getTime() - previous.finishedAt.getTime() < this.refreshMs) {
      return { ...base, status: "REUSED", crawlId: previous.id, pairs: previous.fetchedCount, expected: previous.expectedCount, ...describe(previous), notes: [`reusing the LBank list fetched ${previous.finishedAt.toISOString()}`] };
    }
    const trigger = opts.trigger ?? (opts.force ? "manual" : "schedule");
    const startedAt = new Date();
    try {
      const r = await this.source.lbankSpotPairs(at);
      const status = r.complete ? "COMPLETE" : "INCOMPLETE";
      const crawl = await this.prisma.venueCrawl.create({
        data: { providerId, kind: "lbank_spot_pairs", batchId, startedAt, finishedAt: new Date(), status, expectedCount: r.expectedCount, fetchedCount: r.pairs.length, requests: r.requests, pairs: r.pairs as never, summary: { trigger }, source: r.source, sourceParams: r.params, responseSha256: r.responseSha256, notes: r.notes },
      });
      const events = status === "COMPLETE" ? await this.recordListingEvents(providerId, crawl.id, r.pairs, crawl.finishedAt) : { listed: 0, absent: 0 };
      this.log.log(`LBank spot pairs (${trigger}): ${r.pairs.length}/${r.expectedCount ?? "?"} (${status}); ${events.listed} listed, ${events.absent} absent events`);
      const notes = status === "COMPLETE" || !previous ? r.notes : [...r.notes, `keeping the LBank list fetched ${previous.finishedAt.toISOString()}`];
      return { status, crawlId: crawl.id, pairs: r.pairs.length, expected: r.expectedCount, listedEvents: events.listed, absentEvents: events.absent, ...describe(status === "COMPLETE" ? crawl : previous), notes };
    } catch (err) {
      const message = redact(err).slice(0, 500);
      const crawl = await this.prisma.venueCrawl.create({ data: { providerId, kind: "lbank_spot_pairs", batchId, startedAt, finishedAt: new Date(), status: "FAILED", fetchedCount: 0, pairs: [], summary: { trigger }, source: "lbank_spot_pairs", sourceParams: {}, error: message } });
      this.log.warn(`LBank pair crawl failed (${trigger}): ${message}`);
      return { ...base, status: "FAILED", crawlId: crawl.id, pairs: 0, expected: null, ...describe(previous), notes: previous ? [message, `keeping the LBank list fetched ${previous.finishedAt.toISOString()}`] : [message] };
    }
  }

  /**
   * Listing transitions per (CMC id, LBank pair): LISTED when first seen or back after an absence,
   * ABSENT when a complete crawl no longer contains a listed pair (assumptions A9, A12).
   */
  async recordListingEvents(providerId: string, crawlId: string, pairs: VenuePair[], at: Date): Promise<{ listed: number; absent: number }> {
    const current = new Set(pairs.filter((p) => p.category === "spot" && p.baseCurrencyId !== null).map((p) => `${p.baseCurrencyId}|${p.marketPair}`));
    const latest = await this.prisma.$queryRaw<Array<{ cmcId: number; marketPair: string; event: string }>>`
      SELECT DISTINCT ON ("cmcId", "marketPair") "cmcId", "marketPair", event
      FROM "VenuePairEvent" WHERE "providerId" = ${providerId} AND exchange = ${LBANK} AND at <= ${at}
      ORDER BY "cmcId", "marketPair", at DESC, id DESC`;
    const last = new Map(latest.map((e) => [`${e.cmcId}|${e.marketPair}`, e.event]));
    const rows: Array<{ providerId: string; exchange: string; cmcId: number; marketPair: string; event: string; crawlId: string; at: Date }> = [];
    for (const key of current) {
      if (last.get(key) === "LISTED") continue;
      const [id, ...pair] = key.split("|");
      rows.push({ providerId, exchange: LBANK, cmcId: Number(id), marketPair: pair.join("|"), event: "LISTED", crawlId, at });
    }
    for (const [key, ev] of last) {
      if (ev !== "LISTED" || current.has(key)) continue;
      const [id, ...pair] = key.split("|");
      rows.push({ providerId, exchange: LBANK, cmcId: Number(id), marketPair: pair.join("|"), event: "ABSENT", crawlId, at });
    }
    if (rows.length) await this.prisma.venuePairEvent.createMany({ data: rows });
    return { listed: rows.filter((r) => r.event === "LISTED").length, absent: rows.filter((r) => r.event === "ABSENT").length };
  }

  /** CMC Markets spot pairs for review candidates (stage `venues`), at most once per refresh period each. */
  async refreshAssetMarkets(providerId: string, batchId: string, candidates: Array<{ cmcId: number; slug: string | null }>, at: Date): Promise<VenueRefreshReport> {
    const report: VenueRefreshReport = { candidates: candidates.length, due: 0, attempted: 0, fetched: 0, failed: 0, stoppedBy: null, notes: [] };
    if (!this.source || this.source.providerId !== providerId || !candidates.length) return report;
    const since = new Date(at.getTime() - this.cfg.TIER1_VENUE_REFRESH_HOURS * 3_600_000);
    const recent = new Set(
      (await this.prisma.venueCrawl.findMany({ where: { providerId, kind: "asset_markets", cmcId: { in: candidates.map((c) => c.cmcId) }, finishedAt: { gte: since }, status: { not: "FAILED" } }, select: { cmcId: true } })).map((c) => c.cmcId),
    );
    const due = candidates.filter((c) => !recent.has(c.cmcId));
    report.due = due.length;
    const deadline = Date.now() + 10 * 60_000;
    let allowance = await spendableRequests(this.prisma, this.cfg, providerId, at);
    for (const c of due) {
      if (report.attempted >= this.cfg.TIER1_VENUE_MAX_ASSETS_PER_RUN) { report.stoppedBy = "max_assets"; break; }
      if (Date.now() > deadline) { report.stoppedBy = "time_budget"; break; }
      if (allowance <= 0) { report.stoppedBy = "request_budget_reserve"; break; }
      report.attempted++;
      allowance--;
      const startedAt = new Date();
      try {
        const r = await this.source.assetMarkets(c, at);
        await this.prisma.venueCrawl.create({
          data: { providerId, kind: "asset_markets", cmcId: c.cmcId, batchId, startedAt, finishedAt: new Date(), status: r.complete ? "COMPLETE" : "INCOMPLETE", expectedCount: r.expectedCount, fetchedCount: r.pairs.length, requests: r.requests, pairs: r.pairs as never, source: r.source, sourceParams: r.params, responseSha256: r.responseSha256, notes: r.notes },
        });
        report.fetched++;
      } catch (err) {
        report.failed++;
        const message = redact(err).slice(0, 300);
        await this.prisma.venueCrawl.create({ data: { providerId, kind: "asset_markets", cmcId: c.cmcId, batchId, startedAt, finishedAt: new Date(), status: "FAILED", fetchedCount: 0, pairs: [], source: "asset_markets", sourceParams: {}, error: message } });
        if (report.failed <= 5) report.notes.push(`CMC id ${c.cmcId}: ${message}`);
        if (stopsCrawl(err)) { report.stoppedBy = "source_unavailable"; break; }
      }
    }
    return report;
  }
}

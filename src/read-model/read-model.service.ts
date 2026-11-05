import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { D, STORE_DP } from "../common/decimal.js";
import { addDays, isoDate, parseIsoDate } from "../common/dates.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RULES } from "../tier1/constants.js";
import { plain } from "./plain.js";

export type Sheet = "queue" | "eligible" | "needs_review" | "excluded" | "all";

const STAGE_LABELS: Record<string, string> = {
  discover: "Discovering the coin listing",
  collect: "Collecting the crawl batch (every listed coin)",
  lbank: "Reading LBank Spot pairs",
  daily: "Refreshing completed daily rows for screen candidates",
  scan: "Running the Tier 1 scan",
  venues: "Reading CMC Markets venues for review candidates",
  export: "Writing CSV and XLSX exports",
  notify: "Preparing the Telegram summary",
};

const LIST_SELECT = {
  batchId: true, cmcId: true, symbol: true, name: true, slug: true, rank: true, ageDays: true, priceUsd: true, capUsd: true, volume24hUsd: true,
  observedAt: true, crawledAt: true, currentStatus: true, currentReason: true, currentVmc: true, vmc3dAvg: true, vmc7dAvg: true, vmc14dAvg: true, vmc30dAvg: true,
  avg3dReason: true, avg7dReason: true, avg14dReason: true, avg30dReason: true, multiple3d: true, multiple7d: true, multiple30d: true,
  pass3d: true, pass7d: true, pass30d: true, reason3d: true, reason7d: true, reason30d: true, stars: true, eligibilityStatus: true, eligibilityReasons: true,
  assetClass: true, classSource: true, lbankStatus: true, lbankReason: true, lbankPairs: true, venueReview: true, venueFlags: true, flags: true, inQueue: true, queueOrder: true,
} satisfies Prisma.ScanResultSelect;

/**
 * Read-only queries shared by the dashboard API, the MCP server, Telegram and the CLI.
 * PostgreSQL is the source of truth; nothing here writes.
 */
@Injectable()
export class ReadModelService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  /** Batch of the newest successful scan (results exist), or null. */
  async latestScanBatchId(): Promise<string | null> {
    const r = await this.prisma.scanRun.findFirst({ where: { providerId: this.providerId, status: "succeeded" }, orderBy: { asOf: "desc" }, select: { batchId: true } });
    return r?.batchId ?? null;
  }

  async listAssets(q: { search?: string; limit: number; offset: number }) {
    const where: Prisma.CmcAssetWhereInput = {
      providerId: this.providerId,
      ...(q.search ? { OR: [{ symbol: { contains: q.search.toUpperCase() } }, { name: { contains: q.search, mode: "insensitive" as const } }, ...(/^\d+$/.test(q.search) ? [{ cmcId: Number(q.search) }] : [])] } : {}),
    };
    const [total, rows] = await Promise.all([this.prisma.cmcAsset.count({ where }), this.prisma.cmcAsset.findMany({ where, orderBy: [{ symbol: "asc" }, { cmcId: "asc" }], take: q.limit, skip: q.offset })]);
    return plain<Record<string, unknown>>({ total, offset: q.offset, assets: rows });
  }

  async coverage() {
    const providerId = this.providerId;
    const [provider, lastBatch, lastDiscovery, health, assetCount] = await Promise.all([
      this.prisma.provider.findUnique({ where: { id: providerId } }),
      this.prisma.crawlBatch.findFirst({ where: { providerId }, orderBy: { slotTime: "desc" } }),
      this.prisma.discoveryRun.findFirst({ where: { providerId }, orderBy: { startedAt: "desc" } }),
      this.prisma.sourceHealth.findUnique({ where: { providerId } }),
      this.prisma.cmcAsset.count({ where: { providerId } }),
    ]);
    return plain<Record<string, unknown>>({
      provider,
      isLiveData: provider?.isLive ?? false,
      knownAssets: assetCount,
      lastDiscovery,
      lastBatch,
      sourceHealth: health,
      monthlyRequestBudget: providerId === "coinmarketcap_web" ? this.cfg.CMC_WEB_MONTHLY_REQUEST_BUDGET : providerId === "fixture" ? null : this.cfg.SOURCE_MONTHLY_REQUEST_BUDGET,
    });
  }

  /** Stored hourly observations of one CMC id (raw crawler records). */
  async snapshots(cmcId: number, hours: number) {
    const latest = await this.prisma.marketSnapshot.findFirst({ where: { providerId: this.providerId, providerAssetId: String(cmcId) }, orderBy: { slotTime: "desc" }, select: { slotTime: true } });
    if (!latest) return plain<Record<string, unknown>>({ cmcId, snapshots: [] });
    const rows = await this.prisma.marketSnapshot.findMany({
      where: { providerId: this.providerId, providerAssetId: String(cmcId), slotTime: { gt: new Date(latest.slotTime.getTime() - hours * 3_600_000) } },
      orderBy: { slotTime: "asc" },
      select: { slotTime: true, collectedAt: true, observedAt: true, price: true, marketCap: true, marketCapProvenance: true, volumeRolling24h: true, rank: true, dateAdded: true, tags: true, qualityFlags: true, isStale: true, nullReasons: true },
    });
    return plain<Record<string, unknown>>({ cmcId, snapshots: rows });
  }

  async runs(limit: number) {
    const rows = await this.prisma.pipelineRun.findMany({ where: { providerId: this.providerId }, orderBy: { slotTime: "desc" }, take: limit, include: { stages: { orderBy: { startedAt: "asc" } } } });
    return plain<Record<string, unknown>[]>(rows);
  }

  async deliveries(limit: number) {
    const rows = await this.prisma.telegramDelivery.findMany({
      where: { run: { providerId: this.providerId } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, runId: true, partIndex: true, partCount: true, mode: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true, text: true },
    });
    return plain<Record<string, unknown>[]>(rows);
  }

  /**
   * Dashboard overview: progress of the newest pipeline run, the newest crawl batch and scan, the
   * last valid export and a failure banner when the newest analysis did not complete (PDF p.18).
   */
  async overview() {
    const providerId = this.providerId;
    const [provider, latestRun, latestBatch, latestScan, lastGood, lastExport] = await Promise.all([
      this.prisma.provider.findUnique({ where: { id: providerId } }),
      this.prisma.pipelineRun.findFirst({ where: { providerId }, orderBy: [{ slotTime: "desc" }, { startedAt: "desc" }], include: { stages: { orderBy: { startedAt: "asc" } } } }),
      this.prisma.crawlBatch.findFirst({ where: { providerId }, orderBy: { slotTime: "desc" } }),
      this.prisma.scanRun.findFirst({ where: { providerId }, orderBy: { asOf: "desc" } }),
      this.prisma.scanRun.findFirst({ where: { providerId, status: "succeeded" }, orderBy: { asOf: "desc" } }),
      this.prisma.scanRun.findFirst({ where: { providerId, exportStatus: "succeeded" }, orderBy: { exportedAt: "desc" } }),
    ]);
    const lease = latestRun?.status === "running" ? await this.prisma.jobLease.findUnique({ where: { name: "hourly-pipeline" } }) : null;
    const interrupted = latestRun?.status === "running" && (!lease || lease.expiresAt < new Date());
    const banners: string[] = [];
    if (latestBatch?.status === "FAILED") banners.push(`The latest crawl batch (${latestBatch.slotTime.toISOString()}) failed; results below come from an earlier batch.`);
    if (latestScan && latestScan.status === "failed") banners.push(`The latest analysis failed (${latestScan.error ?? "see Batches"}); the last valid export remains ${lastExport ? `batch ${lastExport.batchId.slice(0, 8)}` : "unavailable"}.`);
    if (latestScan && latestScan.status === "succeeded" && latestScan.exportStatus === "failed") banners.push(`Export of the latest batch failed; the previous export (${lastExport ? lastExport.batchId.slice(0, 8) : "none"}) is still the latest valid file.`);
    const crawlAgeMinutes = latestBatch ? Math.round((Date.now() - latestBatch.crawledAt.getTime()) / 60_000) : null;
    if (crawlAgeMinutes !== null && crawlAgeMinutes > this.cfg.MAX_QUOTE_AGE_MINUTES) banners.push(`The newest crawl batch is ${crawlAgeMinutes} minutes old (older than ${this.cfg.MAX_QUOTE_AGE_MINUTES}); collection may have stopped.`);
    return plain<Record<string, unknown>>({
      provider: provider ? { id: provider.id, name: provider.name, isLive: provider.isLive, attribution: provider.attribution } : null,
      isLiveData: provider?.isLive ?? false,
      latestRun: latestRun
        ? { id: latestRun.id, kind: latestRun.kind, slotTime: latestRun.slotTime, status: interrupted ? "interrupted" : latestRun.status, currentStage: latestRun.currentStage, currentStageLabel: latestRun.currentStage ? STAGE_LABELS[latestRun.currentStage] ?? latestRun.currentStage : null, startedAt: latestRun.startedAt, finishedAt: latestRun.finishedAt, stages: latestRun.stages, metrics: latestRun.metrics, error: latestRun.error }
        : null,
      latestBatch,
      scan: lastGood ? { batchId: lastGood.batchId, asOf: lastGood.asOf, finishedAt: lastGood.finishedAt, queueStatus: lastGood.queueStatus, counts: lastGood.counts, warnings: lastGood.warnings, rulesetVersion: lastGood.rulesetVersion, configVersion: lastGood.configVersion, overridesVersion: lastGood.overridesVersion } : null,
      latestScanStatus: latestScan ? { batchId: latestScan.batchId, status: latestScan.status, error: latestScan.error } : null,
      export: lastExport ? { batchId: lastExport.batchId, exportedAt: lastExport.exportedAt, files: lastExport.exportFiles } : null,
      crawlAgeMinutes,
      maxQuoteAgeMinutes: this.cfg.MAX_QUOTE_AGE_MINUTES,
      banners,
      openMappingTasks: await this.prisma.venueMappingTask.count({ where: { providerId, status: "OPEN" } }),
    });
  }

  /** Rows of one result sheet (PDF p.17 sheets), with each asset's latest human review. */
  async scanSheet(q: { sheet: Sheet; batchId?: string; search?: string; limit: number; offset: number }) {
    const batchId = q.batchId ?? (await this.latestScanBatchId());
    if (!batchId) return plain<Record<string, unknown>>({ batchId: null, total: 0, rows: [] });
    const filter: Prisma.ScanResultWhereInput =
      q.sheet === "queue" ? { inQueue: true } : q.sheet === "eligible" ? { eligibilityStatus: "ELIGIBLE" } : q.sheet === "needs_review" ? { eligibilityStatus: "NEEDS_REVIEW" } : q.sheet === "excluded" ? { eligibilityStatus: "EXCLUDED" } : {};
    const search = q.search?.trim();
    const where: Prisma.ScanResultWhereInput = {
      batchId,
      ...filter,
      ...(search ? { OR: [{ symbol: { contains: search.toUpperCase() } }, { name: { contains: search, mode: "insensitive" as const } }, ...(/^\d+$/.test(search) ? [{ cmcId: Number(search) }] : [])] } : {}),
    };
    const orderBy: Prisma.ScanResultOrderByWithRelationInput[] =
      q.sheet === "queue" ? [{ queueOrder: "asc" }] : q.sheet === "excluded" ? [{ rank: { sort: "asc", nulls: "last" } }, { cmcId: "asc" }] : [{ inQueue: "desc" }, { queueOrder: "asc" }, { stars: "desc" }, { cmcId: "asc" }];
    const [total, rows, run] = await Promise.all([
      this.prisma.scanResult.count({ where }),
      this.prisma.scanResult.findMany({ where, orderBy, take: q.limit, skip: q.offset, select: LIST_SELECT }),
      this.prisma.scanRun.findUnique({ where: { batchId }, select: { asOf: true, queueStatus: true, isLive: true } }),
    ]);
    const reviews = await this.latestReviews(rows.map((r) => r.cmcId));
    return plain<Record<string, unknown>>({ batchId, asOf: run?.asOf ?? null, queueStatus: run?.queueStatus ?? null, isLive: run?.isLive ?? null, total, offset: q.offset, rows: rows.map((r) => ({ ...r, review: reviews.get(r.cmcId) ?? null })) });
  }

  private async latestReviews(cmcIds: number[]) {
    if (!cmcIds.length) return new Map<number, Record<string, unknown>>();
    const rows = await this.prisma.review.findMany({
      where: { providerId: this.providerId, cmcId: { in: cmcIds } },
      orderBy: [{ reviewedAt: "desc" }],
      select: { id: true, cmcId: true, batchId: true, revision: true, reviewer: true, reviewedAt: true, venueDecision: true, eventDay: true, finalDecision: true, planStatus: true },
    });
    const out = new Map<number, Record<string, unknown>>();
    for (const r of rows) if (!out.has(r.cmcId)) out.set(r.cmcId, r);
    return out;
  }

  /**
   * Full calculation trace for one CMC id in one batch (PDF p.20 #2): the current observation, the
   * 30 completed daily rows actually used (exact revisions), every window, comparison, eligibility
   * reason, LBank and venue evidence, decisions, tasks and the review history.
   */
  async assetTrace(cmcId: number, batchId?: string) {
    const record = batchId
      ? await this.prisma.scanResult.findUnique({ where: { batchId_cmcId: { batchId, cmcId } } })
      : await this.prisma.scanResult.findFirst({ where: { providerId: this.providerId, cmcId, batchId: (await this.latestScanBatchId()) ?? undefined }, orderBy: { crawledAt: "desc" } });
    if (!record) return null;
    const batch = await this.prisma.crawlBatch.findUniqueOrThrow({ where: { id: record.batchId } });
    const asOfDate = isoDate(batch.crawledAt);
    const lineage = (record.dailyWindow ?? null) as { dates: string[]; revisionIds: Array<number | null>; missingDates: string[]; invalidDates: string[] } | null;
    const usedIds = (lineage?.revisionIds ?? []).filter((x): x is number => x !== null).map((x) => BigInt(x));
    const [snapshot, asset, changes, revisionsUsed, effective, decisions, tasks, reviews, run, markets] = await Promise.all([
      this.prisma.marketSnapshot.findFirst({ where: { providerId: record.providerId, providerAssetId: String(cmcId), slotTime: batch.slotTime } }),
      this.prisma.cmcAsset.findUnique({ where: { providerId_cmcId: { providerId: record.providerId, cmcId } } }),
      this.prisma.cmcAssetChange.findMany({ where: { providerId: record.providerId, cmcId }, orderBy: { observedAt: "desc" }, take: 20 }),
      usedIds.length ? this.prisma.dailyMetricRevision.findMany({ where: { id: { in: usedIds } } }) : Promise.resolve([]),
      this.prisma.dailyMetric.findMany({ where: { providerId: record.providerId, cmcId, dateUtc: { gte: parseIsoDate(addDays(asOfDate, -this.cfg.TIER1_DAILY_LOOKBACK_DAYS)), lt: parseIsoDate(asOfDate) } }, orderBy: { dateUtc: "desc" } }),
      this.prisma.venueDecision.findMany({ where: { providerId: record.providerId, cmcId }, orderBy: { decidedAt: "desc" } }),
      this.prisma.venueMappingTask.findMany({ where: { providerId: record.providerId, cmcId }, orderBy: { updatedAt: "desc" } }),
      this.prisma.review.findMany({ where: { providerId: record.providerId, cmcId }, orderBy: [{ reviewedAt: "desc" }, { revision: "desc" }] }),
      this.prisma.scanRun.findUnique({ where: { batchId: record.batchId } }),
      this.prisma.venueCrawl.findFirst({ where: { providerId: record.providerId, kind: "asset_markets", cmcId }, orderBy: { finishedAt: "desc" } }),
    ]);
    const lbankCrawl = run?.lbankCrawlId ? await this.prisma.venueCrawl.findUnique({ where: { id: run.lbankCrawlId }, select: { id: true, status: true, finishedAt: true, fetchedCount: true, expectedCount: true, source: true, notes: true } }) : null;
    const used = new Map(revisionsUsed.map((r) => [r.id.toString(), r]));
    const effByDate = new Map(effective.map((e) => [isoDate(e.dateUtc), e]));
    const dailyUsed = (lineage?.dates ?? []).map((date, i) => {
      const id = lineage?.revisionIds[i];
      const r = id !== null && id !== undefined ? used.get(String(id)) : undefined;
      const eff = effByDate.get(date);
      const ratio = r && r.valid && r.volumeUsd && r.marketCapUsd && !r.marketCapUsd.isZero() ? new D(r.volumeUsd.toString()).div(r.marketCapUsd.toString()) : null;
      return {
        dateUtc: date,
        daysAgo: i + 1,
        revisionId: id ?? null,
        revision: r?.revision ?? null,
        volumeUsd: r?.volumeUsd?.toString() ?? null,
        marketCapUsd: r?.marketCapUsd?.toString() ?? null,
        closeUsd: r?.closeUsd?.toString() ?? null,
        // Shown at the stored precision of the means and multiples (the scan itself compares unrounded values).
        vmc: ratio?.toDecimalPlaces(STORE_DP).toFixed() ?? null,
        valid: r ? r.valid : null,
        invalidReasons: r?.invalidReasons ?? (lineage?.missingDates.includes(date) ? ["no row stored for this completed day"] : []),
        sourceCloseAt: r?.sourceCloseAt ?? null,
        retrievedAt: r?.retrievedAt ?? null,
        source: r?.source ?? null,
        revisedSinceScan: !!(eff && id !== null && id !== undefined && eff.revisionId.toString() !== String(id)),
      };
    });
    const fmt = (v: { toString(): string } | null) => (v === null ? null : new D(v.toString()).toFixed());
    const windows = RULES.windows.map((n) => {
      const mean = (record as Record<string, unknown>)[`vmc${n}dAvg`] as { toString(): string } | null;
      const reason = (record as Record<string, unknown>)[`avg${n}dReason`] as string | null;
      const rows = dailyUsed.slice(0, n);
      const pass = n === 14 ? null : { multiple: fmt((record as Record<string, unknown>)[`multiple${n}d`] as never), status: (record as Record<string, unknown>)[`pass${n}d`], reason: (record as Record<string, unknown>)[`reason${n}d`] };
      return {
        days: n,
        role: n === 14 ? "context only (no pass/fail, no star, no queue gate)" : "compared with the current VMC",
        dates: rows.map((r) => r.dateUtc),
        mean: fmt(mean),
        reason,
        formula: mean !== null && rows.every((r) => r.vmc !== null) ? `mean_${n}d = (${rows.map((r) => r.vmc).join(" + ")}) / ${n} = ${fmt(mean)}` : `mean_${n}d = N/A (${reason ?? "not evaluated"})`,
        comparison: pass && record.currentVmc && mean && pass.status !== "N/A" ? `${fmt(record.currentVmc)} / ${fmt(mean)} = ${pass.multiple} → ${pass.status} (YES iff ≥ ${RULES.passMultiple})` : pass ? `N/A (${pass.reason ?? "—"})` : null,
        pass,
      };
    });
    return plain<Record<string, unknown>>({
      record,
      batch,
      scanRun: run ? { status: run.status, queueStatus: run.queueStatus, rulesetVersion: run.rulesetVersion, configVersion: run.configVersion, overridesVersion: run.overridesVersion, warnings: run.warnings } : null,
      asset,
      metadataChanges: changes,
      current: {
        label: `rolling 24h, observed at ${record.observedAt ? record.observedAt.toISOString() : "unknown"} (provider update time); crawled at ${record.crawledAt.toISOString()}`,
        formula: record.currentVmc ? `current_vmc = volume_24h / market_cap = ${fmt(record.volume24hUsd)} / ${fmt(record.capUsd)} = ${fmt(record.currentVmc)} (${new D(record.currentVmc.toString()).times(100).toDecimalPlaces(4).toFixed()} %)` : `current_vmc = N/A (${record.currentReason ?? record.currentStatus})`,
        status: record.currentStatus,
        reason: record.currentReason,
        snapshot,
      },
      daily: { asOfDate, latestCompletedDate: addDays(asOfDate, -1), used: dailyUsed, effectiveNow: effective },
      windows,
      eligibility: { status: record.eligibilityStatus, reasons: record.eligibilityReasons, assetClass: record.assetClass, classSource: record.classSource, rules: { rank: `${RULES.rankMin}–${RULES.rankMax}`, minMarketCapUsd: RULES.minMarketCapUsd, minListingAgeDays: 60 } },
      lbank: { status: record.lbankStatus, reason: record.lbankReason, pairs: record.lbankPairs, crawl: lbankCrawl, decisions: decisions.filter((d) => d.exchange === "lbank"), tasks },
      venues: { review: record.venueReview, flags: record.venueFlags, summary: (record.diagnostics as { venue?: unknown } | null)?.venue ?? null, crawl: markets ? { id: markets.id, status: markets.status, finishedAt: markets.finishedAt, expectedCount: markets.expectedCount, fetchedCount: markets.fetchedCount, pairs: markets.pairs, notes: markets.notes } : null },
      reviews,
    });
  }

  async batches(limit: number) {
    const rows = await this.prisma.crawlBatch.findMany({ where: { providerId: this.providerId }, orderBy: { slotTime: "desc" }, take: limit });
    const runs = new Map((await this.prisma.scanRun.findMany({ where: { batchId: { in: rows.map((r) => r.id) } } })).map((r) => [r.batchId, r]));
    return plain<Array<Record<string, unknown>>>(
      rows.map((b) => {
        const r = runs.get(b.id);
        return { ...b, scan: r ? { status: r.status, queueStatus: r.queueStatus, counts: r.counts, warnings: r.warnings, attempts: r.attempts, finishedAt: r.finishedAt, exportStatus: r.exportStatus, exportedAt: r.exportedAt, error: r.error } : null };
      }),
    );
  }

  async exportsList(limit: number) {
    const rows = await this.prisma.scanRun.findMany({ where: { providerId: this.providerId, exportStatus: { not: null } }, orderBy: { asOf: "desc" }, take: limit, select: { batchId: true, asOf: true, isLive: true, queueStatus: true, exportStatus: true, exportPath: true, exportFiles: true, exportedAt: true, error: true } });
    return plain<Array<Record<string, unknown>>>(rows.map((r) => ({ ...r, exportPath: r.exportPath ? r.exportPath.replace(resolve(this.cfg.TIER1_EXPORT_DIR), this.cfg.TIER1_EXPORT_DIR) : null, available: !!r.exportPath && existsSync(r.exportPath) })));
  }

  /** Absolute path of one exported file of a batch, only if it is listed in that export. */
  async exportFile(batchId: string, name: string): Promise<string | null> {
    const run = await this.prisma.scanRun.findUnique({ where: { batchId }, select: { exportPath: true, exportFiles: true } });
    if (!run?.exportPath) return null;
    const files = ((run.exportFiles ?? []) as Array<{ name: string }>).map((f) => f.name).concat("manifest.json");
    if (!files.includes(name)) return null;
    const root = resolve(this.cfg.TIER1_EXPORT_DIR);
    const full = resolve(join(run.exportPath, name));
    if (!full.startsWith(root + sep) || !existsSync(full)) return null;
    return full;
  }

  async mappingTasks(status: "OPEN" | "RESOLVED" | "ALL", limit: number) {
    const rows = await this.prisma.venueMappingTask.findMany({ where: { providerId: this.providerId, ...(status === "ALL" ? {} : { status }) }, orderBy: { updatedAt: "desc" }, take: limit });
    return plain<Array<Record<string, unknown>>>(rows);
  }
}

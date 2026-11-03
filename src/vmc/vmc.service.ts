import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig, describeConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { LeaseService } from "../pipeline/lease.service.js";
import { CmcWebClient, WEB_CHART, WEB_DETAIL, WEB_HISTORY, type RecordWebResponse } from "../sources/coinmarketcap-web/client.js";
import { parseWebDaily, parseWebHourly, parseWebIdentity, parseWebLatest, websiteData } from "../sources/coinmarketcap-web/parse.js";
import { BASELINE_FORMULA_VERSION, computeBaseline } from "./baseline.js";
import { CmcApiError, CmcClient } from "./cmc-client.js";
import { fixtureFetch } from "./cmc-fixture.js";
import {
  type DailyRow,
  type HourlyRow,
  parseDailyEodQuotes,
  parseDailyOhlcv,
  parseHourlyHistorical,
  parseKeyInfo,
  parseLatestQuotes,
  parseMap,
  validatePair,
} from "./cmc-parse.js";
import { analyzeWindow, buildRow, type ComparisonRow, formatTable } from "./comparison.js";
import { parseCmcHistoryCsv } from "./csv-import.js";
import { Decimal, sha256 } from "./decimal.js";
import { addDays, baselineWindow, daysInclusive, eachDay, HOUR_MS, hourFloor, isoDate, parseIsoDate } from "./window.js";

type Job = "probe" | "sync_assets" | "daily_history" | "baseline" | "hourly_backfill" | "hourly" | "csv_import";

interface RunCtx {
  runId: string;
  client: CmcClient;
  now: Date;
  record: RecordWebResponse;
  result: (cmcId: number, status: "ok" | "partial" | "failed" | "skipped", detail: Record<string, unknown>, error?: string) => Promise<void>;
}

export interface JobOutcome {
  runId: string | null;
  job: Job;
  status: "succeeded" | "partial" | "failed" | "skipped";
  reason?: string;
  creditsUsed: number;
  assets: Record<string, string>;
}

/** Errors that apply to every asset/request in a run: stop instead of repeating them. */
const RUN_ABORTING = new Set(["auth", "billing", "credits_exhausted", "budget", "plan_not_authorized", "rate_limited"]);
const CAPABILITIES_KEY = "vmc.capabilities";
const BACKFILL_UNAVAILABLE_KEY = "vmc.hourlyBackfillUnavailable";

@Injectable()
export class VmcService {
  private readonly log = new Logger(VmcService.name);
  /** Test hook: override the clock. */
  now: () => Date = () => new Date();
  /** Test hook: override the HTTP transport (defaults to fixture or global fetch). */
  fetchImpl: typeof fetch | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly leases: LeaseService,
    private readonly web: CmcWebClient,
  ) {}

  get isFixture() {
    return this.cfg.VMC_SOURCE === "fixture";
  }

  get assetIds(): number[] {
    return this.cfg.VMC_ASSET_IDS;
  }

  private get isWeb() { return this.cfg.VMC_SOURCE === "cmc_web"; }

  private recordRaw(runId: string): RecordWebResponse {
    return async (r) => {
      const row = await this.prisma.vmcRawResponse.create({
        data: { runId, endpoint: r.endpoint, params: r.params, httpStatus: r.httpStatus, errorCode: r.errorCode, creditCount: r.creditCount, retrievedAt: r.retrievedAt, body: r.body, bodySha256: sha256(r.body), isFixture: this.isFixture },
      });
      return row.id;
    };
  }

  private makeClient(runId: string): CmcClient {
    const monthStart = () => {
      const n = this.now();
      return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
    };
    return new CmcClient({
      apiKey: this.isFixture ? "fixture-no-key" : this.cfg.CMC_API_KEY,
      requestsPerMinute: this.isFixture ? 100_000 : this.cfg.VMC_REQUESTS_PER_MINUTE,
      maxRetries: this.cfg.VMC_MAX_RETRIES,
      monthlyCreditBudget: this.cfg.VMC_MONTHLY_CREDIT_BUDGET,
      fetchImpl: this.fetchImpl ?? (this.isFixture ? fixtureFetch(this.now) : undefined),
      now: this.now,
      creditsUsedThisMonth: async () =>
        (await this.prisma.vmcRawResponse.aggregate({ where: { isFixture: this.isFixture, retrievedAt: { gte: monthStart() } }, _sum: { creditCount: true } }))._sum.creditCount ?? 0,
      record: this.recordRaw(runId),
    });
  }

  /** Run a job under a database lease (no overlap across instances) with run/asset records. */
  private async withRun(job: Job, fn: (ctx: RunCtx) => Promise<Record<string, unknown> | void>, scheduledFor?: Date): Promise<JobOutcome> {
    const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const lease = `vmc:${job}`;
    if (!(await this.leases.acquire(lease, holder, 30 * 60_000))) {
      return { runId: null, job, status: "skipped", reason: "another instance is running this job", creditsUsed: 0, assets: {} };
    }
    const now = this.now();
    const d = describeConfig(this.cfg);
    const run = await this.prisma.vmcRun.create({
      data: {
        job,
        status: "running",
        isFixture: this.isFixture,
        scheduledFor: scheduledFor ?? null,
        startedAt: now,
        config: Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith("VMC_") || k.startsWith("CMC_WEB_") || k === "CMC_PLAN" || k === "CMC_API_KEY")) as never,
      },
    });
    const client = this.makeClient(run.id);
    const assets: Record<string, string> = {};
    const ctx: RunCtx = {
      runId: run.id,
      client,
      now,
      record: this.recordRaw(run.id),
      result: async (cmcId, status, detail, error) => {
        assets[cmcId] = status;
        await this.prisma.vmcAssetResult.upsert({
          where: { runId_cmcId: { runId: run.id, cmcId } },
          create: { runId: run.id, cmcId, status, detail: detail as never, error: error ? redact(error).slice(0, 1000) : null },
          update: { status, detail: detail as never, error: error ? redact(error).slice(0, 1000) : null },
        });
      },
    };
    const beat = setInterval(() => void this.leases.heartbeat(lease, holder, 30 * 60_000).catch(() => undefined), 60_000);
    try {
      const summary = (await fn(ctx)) ?? {};
      const statuses = Object.values(assets);
      const failed = statuses.filter((s) => s === "failed").length;
      const succeeded = statuses.filter((s) => s === "ok" || s === "partial").length;
      const status = failed === 0 ? (statuses.includes("partial") ? "partial" : "succeeded") : succeeded === 0 ? "failed" : "partial";
      await this.prisma.vmcRun.update({ where: { id: run.id }, data: { status, finishedAt: this.now(), creditsUsed: client.creditsThisRun, summary: summary as never } });
      return { runId: run.id, job, status, creditsUsed: client.creditsThisRun, assets };
    } catch (err) {
      await this.prisma.vmcRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: this.now(), creditsUsed: client.creditsThisRun, error: redact(err).slice(0, 2000) } });
      return { runId: run.id, job, status: "failed", reason: redact(err).slice(0, 300), creditsUsed: client.creditsThisRun, assets };
    } finally {
      clearInterval(beat);
      await this.leases.release(lease, holder).catch(() => undefined);
    }
  }

  /** Apply a per-asset step; run-wide API errors stop the remaining assets (marked skipped). */
  private async forEachAsset(ctx: RunCtx, ids: number[], step: (id: number) => Promise<void>) {
    let abort: CmcApiError | null = null;
    for (const id of ids) {
      if (abort) {
        await ctx.result(id, "skipped", { reason: `run aborted: ${abort.kind}` });
        continue;
      }
      try {
        await step(id);
      } catch (err) {
        const kind = err instanceof CmcApiError ? err.kind : "error";
        await ctx.result(id, "failed", { kind, httpStatus: err instanceof CmcApiError ? err.httpStatus : null, errorCode: err instanceof CmcApiError ? err.errorCode : null }, String(err instanceof Error ? err.message : err));
        if (err instanceof CmcApiError && RUN_ABORTING.has(err.kind)) abort = err;
      }
    }
    return abort;
  }

  // ---------------------------------------------------------------------------------------
  // Probe: verify plan capabilities against the actual key (never assumed from a quote call)
  // ---------------------------------------------------------------------------------------
  probe(): Promise<JobOutcome> {
    return this.withRun("probe", async (ctx) => {
      if (this.isWeb) {
        const id = this.assetIds[0] ?? 1;
        const detail = await this.web.get(WEB_DETAIL, { id, convertId: 2781 }, ctx.record);
        const identity = parseWebIdentity(websiteData(detail.body), id);
        const latest = await this.web.coin(id, identity.slug, ctx.record);
        const quote = parseWebLatest(latest.body as Record<string, unknown>, id);
        const end = Math.floor(ctx.now.getTime() / 1000);
        const daily = await this.web.get(WEB_HISTORY, { id, convertId: 2781, timeStart: end - 7 * 86400, timeEnd: end, interval: "1d" }, ctx.record);
        const history = parseWebDaily(daily.body, id, ctx.now);
        const chart = await this.web.get(WEB_CHART, { id, convertId: 2781, range: "7D" }, ctx.record);
        const hourly = parseWebHourly(chart.body, id, new Date(ctx.now.getTime() - 72 * HOUR_MS), ctx.now);
        const caps = { checkedAt: ctx.now.toISOString(), source: "cmc_web", isFixture: false, coinPage: { available: quote.pair.valid, endpoint: latest.endpoint }, dailyHistory: { available: history.rows.some((r) => r.valid), convention: "ohlcv", returnedDays: history.rows.length }, hourlyHistory: { available: hourly.some((r) => r.valid), range: "7D", returnedHours: hourly.length }, keyRequired: false };
        await this.prisma.appState.upsert({ where: { key: CAPABILITIES_KEY }, create: { key: CAPABILITIES_KEY, value: caps }, update: { value: caps } });
        return caps;
      }
      const caps: Record<string, unknown> = { checkedAt: ctx.now.toISOString(), configuredPlan: this.cfg.CMC_PLAN, isFixture: this.isFixture };
      const attempt = async (name: string, endpoint: string, params: Record<string, string | number>, credits: number) => {
        try {
          const r = await ctx.client.get(endpoint, params, credits);
          caps[name] = { available: true, creditCount: r.creditCount };
          return r;
        } catch (err) {
          caps[name] = { available: false, kind: err instanceof CmcApiError ? err.kind : "error", errorCode: err instanceof CmcApiError ? err.errorCode : null, message: redact(err instanceof Error ? err.message : err) };
          if (err instanceof CmcApiError && ["auth", "billing", "credits_exhausted", "budget"].includes(err.kind)) throw err;
          return null;
        }
      };
      const key = await attempt("keyInfo", "/v1/key/info", {}, 0);
      caps.keyInfo = { ...(caps.keyInfo as object), ...(key ? parseKeyInfo(key.body) : {}) };
      await attempt("quotesLatestV3", "/v3/cryptocurrency/quotes/latest", { id: 1, convert: "USD" }, 1);
      await attempt("quotesHistoricalDaily", "/v3/cryptocurrency/quotes/historical", { id: 1, interval: "daily", count: 1, convert: "USD" }, 1);
      await attempt("quotesHistoricalHourly", "/v3/cryptocurrency/quotes/historical", { id: 1, interval: "hourly", count: 1, convert: "USD" }, 1);
      await attempt("ohlcvHistoricalDaily", "/v2/cryptocurrency/ohlcv/historical", { id: 1, time_period: "daily", count: 1, convert: "USD" }, 1);
      await this.prisma.appState.upsert({ where: { key: CAPABILITIES_KEY }, create: { key: CAPABILITIES_KEY, value: caps as never }, update: { value: caps as never } });
      return caps;
    });
  }

  async capabilities(): Promise<Record<string, unknown> | null> {
    return ((await this.prisma.appState.findUnique({ where: { key: CAPABILITIES_KEY } }))?.value as Record<string, unknown>) ?? null;
  }

  // ---------------------------------------------------------------------------------------
  // Asset identity: CMC numeric id is the key; symbol/name changes are logged, never re-keyed
  // ---------------------------------------------------------------------------------------
  syncAssets(): Promise<JobOutcome> {
    return this.withRun("sync_assets", async (ctx) => {
      const wanted = new Set(this.assetIds);
      const found = new Map<number, ReturnType<typeof parseMap>[number]>();
      if (this.isWeb) {
        await this.forEachAsset(ctx, this.assetIds, async (id) => {
          const r = await this.web.get(WEB_DETAIL, { id, convertId: 2781 }, ctx.record);
          found.set(id, parseWebIdentity(websiteData(r.body), id));
        });
      } else {
        for (const status of ["active", "inactive", "untracked"]) {
          for (let start = 1; wanted.size > found.size && start < 100_000; start += 5000) {
            const r = await ctx.client.get("/v1/cryptocurrency/map", { listing_status: status, start, limit: 5000, sort: "id", aux: "first_historical_data,last_historical_data,is_active" }, 0);
            const page = parseMap(r.body);
            for (const e of page) if (wanted.has(e.cmcId)) found.set(e.cmcId, e);
            if (page.length < 5000) break;
          }
          if (found.size === wanted.size) break;
        }
      }
      for (const id of this.assetIds) {
        const e = found.get(id);
        if (!e) {
          if (this.isWeb) continue; // forEachAsset already recorded the precise failure/skip.
          await ctx.result(id, "failed", { reason: "cmc_id_not_found_in_map" }, `CMC id ${id} not found in /v1/cryptocurrency/map`);
          continue;
        }
        const prev = await this.prisma.vmcAsset.findUnique({ where: { cmcId: id } });
        const changes = prev
          ? (["symbol", "name", "slug"] as const).filter((f) => (prev[f] ?? null) !== (e[f] ?? null)).map((f) => ({ cmcId: id, field: f, oldValue: prev[f] ?? null, newValue: e[f] ?? null, observedAt: ctx.now, runId: ctx.runId }))
          : [];
        const meta = { symbol: e.symbol, name: e.name, slug: e.slug, isActive: e.isActive, firstHistoricalAt: e.firstHistoricalAt, lastHistoricalAt: e.lastHistoricalAt, metadataSource: this.isWeb ? WEB_DETAIL : "/v1/cryptocurrency/map" };
        await this.prisma.$transaction([
          this.prisma.vmcAsset.upsert({ where: { cmcId: id }, create: { cmcId: id, ...meta }, update: meta }),
          this.prisma.vmcAssetMetadataChange.createMany({ data: changes }),
        ]);
        await ctx.result(id, "ok", { symbol: e.symbol, name: e.name, metadataChanges: changes.map((c) => c.field) });
      }
      return { requested: this.assetIds.length, found: found.size };
    });
  }

  private async requireAssets(ctx: RunCtx): Promise<number[]> {
    const known = new Set((await this.prisma.vmcAsset.findMany({ where: { cmcId: { in: this.assetIds } }, select: { cmcId: true } })).map((a) => a.cmcId));
    const ready: number[] = [];
    for (const id of this.assetIds) {
      if (known.has(id)) ready.push(id);
      else await ctx.result(id, "skipped", { reason: "asset not synced; run vmc:sync-assets" });
    }
    return ready;
  }

  // ---------------------------------------------------------------------------------------
  // Daily history (baseline inputs): backfill + incremental refresh with correction window
  // ---------------------------------------------------------------------------------------
  dailyHistory(opts: { full?: boolean } = {}): Promise<JobOutcome> {
    return this.withRun("daily_history", async (ctx) => {
      const conv = this.cfg.VMC_DAILY_CONVENTION;
      const win = baselineWindow(ctx.now, this.cfg.VMC_BASELINE_MONTHS);
      const ids = await this.requireAssets(ctx);
      await this.forEachAsset(ctx, ids, async (id) => {
        const last = await this.prisma.vmcDailyCurrent.findFirst({ where: { cmcId: id, convention: conv }, orderBy: { dateUtc: "desc" } });
        const lastDate = last ? isoDate(last.dateUtc) : null;
        const from = opts.full || !lastDate || lastDate < win.start ? win.start : [win.start, addDays(lastDate, -this.cfg.VMC_DAILY_REFRESH_LOOKBACK_DAYS + 1)].sort().at(-1)!;
        if (from > win.end) return ctx.result(id, "ok", { reason: "up to date", window: win });
        const days = daysInclusive(from, win.end);
        const credits = Math.ceil(days / 100);
        let rows: DailyRow[];
        let endpoint: string;
        let params: Record<string, string | number>;
        let notes: Record<string, unknown> = {};
        let rawId: string;
        if (this.isWeb) {
          endpoint = WEB_HISTORY;
          params = { id, convertId: 2781, timeStart: Math.floor(parseIsoDate(from).getTime() / 1000), timeEnd: Math.floor(parseIsoDate(addDays(win.end, 1)).getTime() / 1000) - 1, interval: "1d" };
          const r = await this.web.get(endpoint, params, ctx.record);
          rawId = r.rawResponseId;
          const parsed = parseWebDaily(r.body, id, ctx.now);
          rows = parsed.rows;
          notes = { incompletePeriodsSkipped: parsed.incompleteSkipped };
        } else if (conv === "eod_quote") {
          endpoint = "/v3/cryptocurrency/quotes/historical";
          params = {
            id,
            interval: "daily",
            convert: "USD",
            time_start: `${addDays(from, 1)}T00:00:00.000Z`,
            time_end: new Date(parseIsoDate(addDays(win.end, 1)).getTime() + this.cfg.VMC_EOD_MAX_OFFSET_MINUTES * 60_000).toISOString(),
          };
          const r = await ctx.client.get(endpoint, params, credits);
          rawId = r.rawResponseId;
          const parsed = parseDailyEodQuotes(r.body, this.cfg.VMC_EOD_MAX_OFFSET_MINUTES);
          rows = parsed.rows;
          notes = { duplicateSamplesIgnored: parsed.duplicates };
        } else {
          endpoint = "/v2/cryptocurrency/ohlcv/historical";
          params = { id, time_period: "daily", interval: "daily", convert: "USD", time_start: addDays(from, -1), time_end: win.end };
          const r = await ctx.client.get(endpoint, params, credits);
          rawId = r.rawResponseId;
          const parsed = parseDailyOhlcv(r.body, ctx.now);
          rows = parsed.rows;
          notes = { incompletePeriodsSkipped: parsed.incompleteSkipped };
        }
        const inRange = rows.filter((x) => x.cmcId === id && x.dateUtc >= from && x.dateUtc <= win.end);
        const counts = { inserted: 0, revised: 0, unchanged: 0, invalid: 0 };
        for (const row of inRange) {
          const res = await this.upsertDaily(row, conv, rawId, ctx);
          counts[res]++;
          if (!row.valid) counts.invalid++;
        }
        const got = new Set(inRange.map((x) => x.dateUtc));
        const missing = eachDay(from, win.end).filter((d) => !got.has(d));
        await ctx.result(id, missing.length || counts.invalid ? "partial" : "ok", { endpoint, params, range: { from, to: win.end }, returned: inRange.length, missingDays: missing.length, missingSample: missing.slice(0, 10), ...counts, ...notes });
      });
      return { convention: conv, window: win };
    });
  }

  /** Insert a new revision only when content differs from the effective one (retry ≠ revision). */
  private async upsertDaily(row: DailyRow, conv: string, rawId: string, ctx: RunCtx): Promise<"inserted" | "revised" | "unchanged"> {
    const date = parseIsoDate(row.dateUtc);
    const hash = sha256(JSON.stringify([row.volume?.toString() ?? null, row.marketCap?.toString() ?? null, row.valid, row.invalidReasons, row.sourceTimestamp?.toISOString() ?? null]));
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.vmcDailyCurrent.findUnique({ where: { cmcId_dateUtc_convention: { cmcId: row.cmcId, dateUtc: date, convention: conv } } });
      const curObs = cur ? await tx.vmcDailyObservation.findUnique({ where: { id: cur.observationId } }) : null;
      if (curObs?.contentHash === hash) return "unchanged" as const;
      const obs = await tx.vmcDailyObservation.create({
        data: {
          cmcId: row.cmcId,
          dateUtc: date,
          convention: conv,
          sourceTimestamp: row.sourceTimestamp,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          volumeUsd: row.volume,
          marketCapUsd: row.marketCap,
          ratio: row.ratio,
          valid: row.valid,
          invalidReasons: row.invalidReasons,
          revision: (curObs?.revision ?? 0) + 1,
          revisionReason: curObs ? "source_revision" : "first",
          contentHash: hash,
          sourceFields: row.sourceFields as never,
          rawResponseId: rawId,
          runId: ctx.runId,
          retrievedAt: ctx.now,
        },
      });
      await tx.vmcDailyCurrent.upsert({
        where: { cmcId_dateUtc_convention: { cmcId: row.cmcId, dateUtc: date, convention: conv } },
        create: { cmcId: row.cmcId, dateUtc: date, convention: conv, observationId: obs.id },
        update: { observationId: obs.id },
      });
      return curObs ? ("revised" as const) : ("inserted" as const);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Baseline: computed from persisted effective daily rows only (never from hourly data)
  // ---------------------------------------------------------------------------------------
  baseline(): Promise<JobOutcome> {
    return this.withRun("baseline", async (ctx) => {
      const conv = this.cfg.VMC_DAILY_CONVENTION;
      const win = baselineWindow(ctx.now, this.cfg.VMC_BASELINE_MONTHS);
      const ids = await this.requireAssets(ctx);
      await this.forEachAsset(ctx, ids, async (id) => {
        const asset = await this.prisma.vmcAsset.findUniqueOrThrow({ where: { cmcId: id } });
        const pointers = await this.prisma.vmcDailyCurrent.findMany({ where: { cmcId: id, convention: conv, dateUtc: { gte: parseIsoDate(win.start), lte: parseIsoDate(win.end) } } });
        const obs = await this.prisma.vmcDailyObservation.findMany({ where: { id: { in: pointers.map((p) => p.observationId) } } });
        const result = computeBaseline(
          win,
          obs.map((o) => ({ observationId: o.id, dateUtc: isoDate(o.dateUtc), valid: o.valid, ratio: o.ratio ? new Decimal(o.ratio.toString()) : null, invalidReasons: o.invalidReasons })),
          { minCoverage: this.cfg.VMC_MIN_BASELINE_COVERAGE, firstHistoricalDate: asset.firstHistoricalAt ? isoDate(asset.firstHistoricalAt) : null, convention: conv },
        );
        const latest = await this.prisma.vmcBaseline.findFirst({ where: { cmcId: id }, orderBy: { version: "desc" } });
        if (latest && latest.inputsHash === result.inputsHash) {
          return ctx.result(id, "ok", { unchanged: true, version: latest.version, status: latest.status });
        }
        const version = (latest?.version ?? 0) + 1;
        await this.prisma.$transaction(async (tx) => {
          const b = await tx.vmcBaseline.create({
            data: {
              cmcId: id,
              version,
              formulaVersion: BASELINE_FORMULA_VERSION,
              convention: conv,
              windowStart: parseIsoDate(win.start),
              windowEnd: parseIsoDate(win.end),
              expectedDays: result.expectedDays,
              returnedDays: result.returnedDays,
              validDays: result.validDays,
              invalidDays: result.invalidDays,
              missingDays: result.missingDays,
              coverage: result.coverage.toFixed(6),
              status: result.status,
              statusReasons: result.statusReasons,
              ratioSum: result.ratioSum,
              meanRatio: result.meanRatio,
              firstValidDate: result.firstValidDate ? parseIsoDate(result.firstValidDate) : null,
              lastValidDate: result.lastValidDate ? parseIsoDate(result.lastValidDate) : null,
              inputsHash: result.inputsHash,
              calculatedAt: ctx.now,
              runId: ctx.runId,
            },
          });
          await tx.vmcBaselineMember.createMany({
            data: result.members.map((m) => ({ baselineId: b.id, observationId: m.observationId, dateUtc: parseIsoDate(m.dateUtc), ratio: m.ratio, included: m.included, reason: m.reason })),
          });
        });
        await ctx.result(id, result.status === "unavailable" ? "failed" : result.status === "partial" ? "partial" : "ok", {
          version,
          status: result.status,
          statusReasons: result.statusReasons,
          meanRatio: result.meanRatio?.toString() ?? null,
          validDays: result.validDays,
          expectedDays: result.expectedDays,
          missingDays: result.missingDays,
          window: win,
        });
      });
      return { convention: conv, window: win };
    });
  }

  /**
   * Import a CSV the user downloaded from a coin's CoinMarketCap Historical Data page
   * ("Download CSV"). Stored as the `ohlcv` daily convention (website table semantics) with
   * the full file kept as the raw source; re-imports are idempotent and corrections become
   * revisions, exactly like API data.
   */
  importCsv(opts: { cmcId: number; text: string; fileName: string; symbol?: string; name?: string }): Promise<JobOutcome> {
    return this.withRun("csv_import", async (ctx) => {
      const parsed = parseCmcHistoryCsv(opts.text, opts.cmcId, ctx.now);
      const existing = await this.prisma.vmcAsset.findUnique({ where: { cmcId: opts.cmcId } });
      if (!existing) {
        if (!opts.symbol) throw new Error(`CMC id ${opts.cmcId} is not synced yet; pass --symbol (and --name) to register it from the CSV`);
        await this.prisma.vmcAsset.create({
          data: { cmcId: opts.cmcId, symbol: opts.symbol.toUpperCase(), name: opts.name ?? parsed.name ?? opts.symbol, metadataSource: "manual_csv_import" },
        });
      }
      const raw = await this.prisma.vmcRawResponse.create({
        data: {
          runId: ctx.runId,
          endpoint: "manual_csv_import",
          params: { cmcId: opts.cmcId, file: opts.fileName, columns: parsed.columns },
          httpStatus: null,
          errorCode: null,
          creditCount: 0,
          retrievedAt: ctx.now,
          body: opts.text,
          bodySha256: sha256(opts.text),
          isFixture: false,
        },
      });
      const counts = { inserted: 0, revised: 0, unchanged: 0, invalid: 0 };
      for (const row of parsed.rows) {
        counts[await this.upsertDaily(row, "ohlcv", raw.id, ctx)]++;
        if (!row.valid) counts.invalid++;
      }
      const first = parsed.rows[0]?.dateUtc ?? null;
      const last = parsed.rows.at(-1)?.dateUtc ?? null;
      const gaps = first && last ? eachDay(first, last).length - parsed.rows.length : 0;
      await ctx.result(opts.cmcId, parsed.rows.length === 0 ? "failed" : counts.invalid || gaps ? "partial" : "ok", {
        file: opts.fileName,
        convention: "ohlcv",
        range: { first, last },
        rows: parsed.rows.length,
        missingDaysInRange: gaps,
        skippedIncompleteDay: parsed.skippedIncomplete,
        skippedUnparseable: parsed.skippedUnparseable,
        ...counts,
        note: this.cfg.VMC_DAILY_CONVENTION === "ohlcv" ? null : "VMC_DAILY_CONVENTION is not 'ohlcv': imported rows are stored but not used by the baseline until you set VMC_DAILY_CONVENTION=ohlcv",
      });
      return { file: opts.fileName };
    });
  }

  /** Weekly job: refresh daily history (incl. correction lookback) then recompute baselines. */
  async weekly(): Promise<JobOutcome[]> {
    const daily = await this.dailyHistory();
    const base = await this.baseline();
    return [daily, base];
  }

  // ---------------------------------------------------------------------------------------
  // Hourly snapshots (rolling 24h volume + market cap). Bucket = UTC hour of observation time.
  // ---------------------------------------------------------------------------------------
  hourlyBackfill(opts: { force?: boolean } = {}): Promise<JobOutcome> {
    return this.withRun("hourly_backfill", async (ctx) => {
      const ids = await this.requireAssets(ctx);
      const todo = opts.force ? ids : (await this.prisma.vmcAsset.findMany({ where: { cmcId: { in: ids }, hourlyBackfilledAt: null }, select: { cmcId: true } })).map((a) => a.cmcId);
      for (const id of ids.filter((i) => !todo.includes(i))) await ctx.result(id, "skipped", { reason: "already backfilled (use --force to repeat)" });
      const hours = this.cfg.VMC_RECENT_WINDOW_HOURS;
      const start = new Date(hourFloor(ctx.now).getTime() - (hours - 1) * HOUR_MS);
      const abort = await this.forEachAsset(ctx, todo, async (id) => {
        const endpoint = this.isWeb ? WEB_CHART : "/v3/cryptocurrency/quotes/historical";
        const params: Record<string, string | number> = this.isWeb ? { id, range: "7D", convertId: 2781 } : { id, interval: "hourly", convert: "USD", time_start: start.toISOString(), time_end: ctx.now.toISOString() };
        const r = this.isWeb ? await this.web.get(endpoint, params, ctx.record) : await ctx.client.get(endpoint, params, Math.ceil(hours / 100));
        const rows = this.isWeb ? parseWebHourly(r.body, id, start, ctx.now) : parseHourlyHistorical(r.body).filter((x) => x.cmcId === id && x.hourBucket >= start && x.observedAt <= ctx.now);
        const counts = { inserted: 0, revised: 0, unchanged: 0, olderIgnored: 0 };
        for (const row of rows) counts[await this.upsertHourly(row, { origin: "historical_backfill", endpoint, params, rawId: r.rawResponseId, scheduledHour: null, collectedAt: ctx.now }, ctx)]++;
        if (rows.length) await this.prisma.vmcAsset.update({ where: { cmcId: id }, data: { hourlyBackfilledAt: ctx.now } });
        await ctx.result(id, rows.length < hours ? "partial" : "ok", { endpoint, params, returnedHours: rows.length, expectedHours: hours, ...counts });
      });
      if (abort?.kind === "plan_not_authorized") {
        await this.prisma.appState.upsert({
          where: { key: BACKFILL_UNAVAILABLE_KEY },
          create: { key: BACKFILL_UNAVAILABLE_KEY, value: { reason: abort.message, at: ctx.now.toISOString() } },
          update: { value: { reason: abort.message, at: ctx.now.toISOString() } },
        });
      }
      return { windowStart: start.toISOString(), hours };
    });
  }

  hourly(scheduledFor?: Date): Promise<JobOutcome> {
    const scheduledHour = hourFloor(scheduledFor ?? this.now());
    return this.withRun(
      "hourly",
      async (ctx) => {
        const ids = await this.requireAssets(ctx);
        if (this.isWeb) {
          await this.forEachAsset(ctx, ids, async (id) => {
            const asset = await this.prisma.vmcAsset.findUniqueOrThrow({ where: { cmcId: id } });
            const r = await this.web.coin(id, asset.slug, ctx.record);
            const q = parseWebLatest(r.body as Record<string, unknown>, id);
            const invalid = [...q.pair.invalidReasons];
            if (!q.observedAt) invalid.push("missing_observation_time");
            if (q.observedAt && q.observedAt > this.now()) invalid.push("future_observation_time");
            const row: HourlyRow = { cmcId: id, observedAt: q.observedAt ?? scheduledHour, hourBucket: hourFloor(q.observedAt ?? scheduledHour), ...q.pair, valid: invalid.length === 0, ratio: invalid.length === 0 ? q.pair.ratio : null, invalidReasons: invalid, sourceFields: q.sourceFields };
            const result = await this.upsertHourly(row, { origin: "live_quote", endpoint: r.endpoint, params: r.params, rawId: r.rawResponseId, scheduledHour, collectedAt: this.now() }, ctx);
            const stale = !q.observedAt || this.now().getTime() - q.observedAt.getTime() > this.cfg.VMC_STALE_AFTER_MINUTES * 60_000;
            await ctx.result(id, row.valid && !stale ? "ok" : "partial", { result, endpoint: r.endpoint, observedAt: q.observedAt?.toISOString() ?? null, stale, invalidReasons: invalid });
            await this.recordMetadata(id, q, ctx);
          });
          return { scheduledHour: scheduledHour.toISOString(), source: "cmc_web" };
        }
        const endpoint = "/v3/cryptocurrency/quotes/latest";
        for (let i = 0; i < ids.length; i += this.cfg.VMC_LATEST_BATCH_SIZE) {
          const batch = ids.slice(i, i + this.cfg.VMC_LATEST_BATCH_SIZE);
          const params = { id: batch.join(","), convert: "USD", skip_invalid: "true" };
          let quotes: ReturnType<typeof parseLatestQuotes>;
          let rawId: string;
          try {
            const r = await ctx.client.get(endpoint, params, Math.ceil(batch.length / 250));
            quotes = parseLatestQuotes(r.body);
            rawId = r.rawResponseId;
          } catch (err) {
            for (const id of batch) await ctx.result(id, "failed", { kind: err instanceof CmcApiError ? err.kind : "error" }, String(err instanceof Error ? err.message : err));
            if (err instanceof CmcApiError && RUN_ABORTING.has(err.kind)) break;
            continue;
          }
          for (const id of batch) {
            const q = quotes.find((x) => x.cmcId === id);
            if (!q) {
              await ctx.result(id, "failed", { reason: "asset_missing_in_response" }, "asset not present in quotes/latest response");
              continue;
            }
            const collectedAt = this.now();
            const invalid = [...q.pair.invalidReasons];
            if (!q.observedAt) invalid.push("missing_observation_time");
            const row: HourlyRow = {
              cmcId: id,
              observedAt: q.observedAt ?? scheduledHour,
              hourBucket: hourFloor(q.observedAt ?? scheduledHour),
              ...q.pair,
              valid: q.pair.valid && !!q.observedAt,
              ratio: q.pair.valid && q.observedAt ? q.pair.ratio : null,
              invalidReasons: invalid,
              sourceFields: q.sourceFields,
            };
            const res = await this.upsertHourly(row, { origin: "live_quote", endpoint, params, rawId, scheduledHour, collectedAt }, ctx);
            const stale = q.observedAt ? collectedAt.getTime() - q.observedAt.getTime() > this.cfg.VMC_STALE_AFTER_MINUTES * 60_000 : true;
            await ctx.result(id, row.valid && !stale ? "ok" : "partial", { result: res, observedAt: q.observedAt?.toISOString() ?? null, hourBucket: row.hourBucket.toISOString(), stale, invalidReasons: invalid });
            if (q.symbol && q.name) await this.recordMetadata(id, q, ctx);
          }
        }
        return { scheduledHour: scheduledHour.toISOString() };
      },
      scheduledHour,
    );
  }

  private async recordMetadata(id: number, q: { symbol: string | null; name: string | null; slug: string | null }, ctx: RunCtx) {
    const a = await this.prisma.vmcAsset.findUnique({ where: { cmcId: id } });
    if (!a) return;
    const changes = (["symbol", "name", "slug"] as const).filter((f) => q[f] !== null && q[f] !== a[f]).map((f) => ({ cmcId: id, field: f, oldValue: a[f], newValue: q[f], observedAt: ctx.now, runId: ctx.runId }));
    if (!changes.length) return;
    await this.prisma.$transaction([
      this.prisma.vmcAssetMetadataChange.createMany({ data: changes }),
      this.prisma.vmcAsset.update({ where: { cmcId: id }, data: Object.fromEntries(changes.map((c) => [c.field, c.newValue])) }),
    ]);
  }

  /**
   * One effective snapshot per asset per UTC hour (pointer table). Identical re-delivery is a
   * retry (unchanged); same observation time with different values is a source revision; a
   * later observation within the same hour supersedes the earlier one; an older observation
   * than the effective one is ignored (its raw response is still stored).
   */
  private async upsertHourly(
    row: HourlyRow,
    meta: { origin: string; endpoint: string; params: Record<string, string | number>; rawId: string; scheduledHour: Date | null; collectedAt: Date },
    ctx: RunCtx,
  ): Promise<"inserted" | "revised" | "unchanged" | "olderIgnored"> {
    const hash = sha256(JSON.stringify([row.observedAt.toISOString(), row.volume?.toString() ?? null, row.marketCap?.toString() ?? null, row.valid, row.invalidReasons]));
    const stale = meta.collectedAt.getTime() - row.observedAt.getTime() > this.cfg.VMC_STALE_AFTER_MINUTES * 60_000 && meta.origin === "live_quote";
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.vmcHourlyCurrent.findUnique({ where: { cmcId_hourBucket: { cmcId: row.cmcId, hourBucket: row.hourBucket } } });
      const curSnap = cur ? await tx.vmcHourlySnapshot.findUnique({ where: { id: cur.snapshotId } }) : null;
      if (curSnap?.contentHash === hash) return "unchanged" as const;
      if (curSnap?.observedAt && curSnap.observedAt > row.observedAt) return "olderIgnored" as const;
      const reason = !curSnap ? "first" : curSnap.observedAt && curSnap.observedAt.getTime() === row.observedAt.getTime() ? "source_revision" : "newer_observation_in_hour";
      const snap = await tx.vmcHourlySnapshot.create({
        data: {
          cmcId: row.cmcId,
          hourBucket: row.hourBucket,
          scheduledHour: meta.scheduledHour,
          observedAt: row.observedAt,
          collectedAt: meta.collectedAt,
          volume24hUsd: row.volume,
          marketCapUsd: row.marketCap,
          ratio: row.ratio,
          origin: meta.origin,
          endpoint: meta.endpoint,
          params: meta.params as never,
          valid: row.valid,
          invalidReasons: row.invalidReasons,
          isStale: stale,
          revision: (curSnap?.revision ?? 0) + 1,
          revisionReason: reason,
          contentHash: hash,
          sourceFields: row.sourceFields as never,
          rawResponseId: meta.rawId,
          runId: ctx.runId,
        },
      });
      await tx.vmcHourlyCurrent.upsert({
        where: { cmcId_hourBucket: { cmcId: row.cmcId, hourBucket: row.hourBucket } },
        create: { cmcId: row.cmcId, hourBucket: row.hourBucket, snapshotId: snap.id },
        update: { snapshotId: snap.id },
      });
      return curSnap ? ("revised" as const) : ("inserted" as const);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Comparison output (descriptive only)
  // ---------------------------------------------------------------------------------------
  async comparison(): Promise<{ generatedAt: string; isFixture: boolean; rows: ComparisonRow[]; notes: string[] }> {
    const now = this.now();
    const hours = this.cfg.VMC_RECENT_WINDOW_HOURS;
    const backfillUnavailable = !!(await this.prisma.appState.findUnique({ where: { key: BACKFILL_UNAVAILABLE_KEY } }));
    const rows: ComparisonRow[] = [];
    for (const id of this.assetIds) {
      const asset = await this.prisma.vmcAsset.findUnique({ where: { cmcId: id } });
      const pointers = await this.prisma.vmcHourlyCurrent.findMany({ where: { cmcId: id }, orderBy: { hourBucket: "desc" }, take: hours * 4 });
      const snaps = await this.prisma.vmcHourlySnapshot.findMany({ where: { id: { in: pointers.map((p) => p.snapshotId) } }, orderBy: { hourBucket: "desc" } });
      const latest = snaps.find((s) => s.valid) ?? snaps[0] ?? null;
      const b = await this.prisma.vmcBaseline.findFirst({ where: { cmcId: id }, orderBy: { version: "desc" } });
      rows.push(
        buildRow(
          {
            cmcId: id,
            symbol: asset?.symbol ?? "?",
            name: asset?.name ?? "(not synced)",
            latest: latest
              ? {
                  observedAt: latest.observedAt,
                  volume24hUsd: latest.volume24hUsd ? new Decimal(latest.volume24hUsd.toString()) : null,
                  marketCapUsd: latest.marketCapUsd ? new Decimal(latest.marketCapUsd.toString()) : null,
                  ratio: latest.ratio ? new Decimal(latest.ratio.toString()) : null,
                  valid: latest.valid,
                  invalidReasons: latest.invalidReasons,
                }
              : null,
            baseline: b
              ? {
                  meanRatio: b.meanRatio ? new Decimal(b.meanRatio.toString()) : null,
                  status: b.status,
                  validDays: b.validDays,
                  expectedDays: b.expectedDays,
                  coverage: b.coverage.toNumber(),
                  windowStart: isoDate(b.windowStart),
                  windowEnd: isoDate(b.windowEnd),
                  calculatedAt: b.calculatedAt,
                  version: b.version,
                }
              : null,
            window: analyzeWindow(now, hours, snaps.map((s) => ({ hourBucket: s.hourBucket, valid: s.valid }))),
            hourlyBackfill: asset?.hourlyBackfilledAt ? "done" : backfillUnavailable ? "unavailable" : "not_done",
          },
          now,
          this.cfg.VMC_STALE_AFTER_MINUTES,
        ),
      );
    }
    return {
      generatedAt: now.toISOString(),
      isFixture: this.isFixture,
      rows,
      notes: [
        "Hourly values use ROLLING 24h volume at each observation time; they are not volume traded within the hour.",
        "Baseline uses completed daily records only (never hourly snapshots).",
        "ratioToBaseline is descriptive; no thresholds or recommendations are applied.",
      ],
    };
  }

  /** Render and optionally write the comparison to the configured destination. */
  async writeComparison(format = this.cfg.VMC_OUTPUT_FORMAT, file = this.cfg.VMC_OUTPUT_FILE): Promise<string> {
    const c = await this.comparison();
    const text = format === "json" ? JSON.stringify(c, null, 2) : formatTable(c.rows, { generatedAt: new Date(c.generatedAt), isFixture: c.isFixture });
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${text}\n`);
    }
    return text;
  }

  /** Detail for one asset: window snapshots, latest baseline with membership summary, metadata log. */
  async assetDetail(cmcId: number) {
    const hours = this.cfg.VMC_RECENT_WINDOW_HOURS;
    const end = hourFloor(this.now());
    const start = new Date(end.getTime() - (hours - 1) * HOUR_MS);
    const pointers = await this.prisma.vmcHourlyCurrent.findMany({ where: { cmcId, hourBucket: { gte: start } } });
    const [asset, snaps, baseline, changes] = await Promise.all([
      this.prisma.vmcAsset.findUnique({ where: { cmcId } }),
      this.prisma.vmcHourlySnapshot.findMany({ where: { id: { in: pointers.map((p) => p.snapshotId) } }, orderBy: { hourBucket: "asc" } }),
      this.prisma.vmcBaseline.findFirst({ where: { cmcId }, orderBy: { version: "desc" }, include: { members: { orderBy: { dateUtc: "asc" } } } }),
      this.prisma.vmcAssetMetadataChange.findMany({ where: { cmcId }, orderBy: { observedAt: "desc" }, take: 20 }),
    ]);
    return { asset, window: analyzeWindow(this.now(), hours, snaps.map((s) => ({ hourBucket: s.hourBucket, valid: s.valid }))), snapshots: snaps, baseline, metadataChanges: changes };
  }

  /** Recompute a ratio from stored inputs (used by tests/audits to confirm reproducibility). */
  static recompute(volume: string, marketCap: string) {
    return validatePair(volume, marketCap).ratio?.toString() ?? null;
  }
}

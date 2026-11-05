import { basename } from "node:path";
import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CronTime } from "cron";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PipelineService } from "../pipeline/pipeline.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReadModelService } from "../read-model/read-model.service.js";
import { TelegramAccessService, isChatId } from "../telegram/access.service.js";
import { TelegramAdminService } from "../telegram/admin.service.js";
import { RULES, RULESET_VERSION } from "../tier1/constants.js";
import { loadOverrides } from "../tier1/overrides.js";
import { ReviewInputError, ReviewService } from "../tier1/review.service.js";
import { CANDLE_STATES, EVENT_DAYS, FINAL_DECISIONS, JUDGMENTS, MARKET_REGIMES, VENUE_DECISIONS } from "../tier1/review-rules.js";
import { VenuesService } from "../tier1/venues.service.js";
import { LOOPBACK, assertTrustedWrite } from "./write-guard.js";

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

const uuid = z.string().uuid();
const cmcIdParam = z.coerce.number().int().positive().max(2_000_000_000);

function nextCronRun(expr: string): string | null {
  try {
    return new CronTime(expr, "UTC").sendAt().toUTC().toISO();
  } catch {
    return null;
  }
}

/** JSON API for the dashboard. Reads go through the read model; writes need JSON, same origin and loopback or Basic auth. */
@Controller("api")
export class DashboardController {
  constructor(
    private readonly read: ReadModelService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly reviews: ReviewService,
    private readonly pipeline: PipelineService,
    private readonly venues: VenuesService,
    private readonly access: TelegramAccessService,
    private readonly admin: TelegramAdminService,
  ) {}

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ReviewInputError) throw new BadRequestException(err.issues.join("; "));
      throw err;
    }
  }

  @Get("config")
  async config() {
    const provider = await this.prisma.provider.findUnique({ where: { id: this.cfg.DATA_SOURCE } });
    let overrides: { version: string; count: number } | { error: string };
    try {
      const o = loadOverrides(this.cfg.TIER1_OVERRIDES_FILE);
      overrides = { version: o.version, count: o.count };
    } catch (err) {
      overrides = { error: err instanceof Error ? err.message : String(err) };
    }
    return {
      timezone: this.cfg.DISPLAY_TIMEZONE,
      dataSource: this.cfg.DATA_SOURCE,
      isLiveData: provider?.isLive ?? this.cfg.DATA_SOURCE !== "fixture",
      providerName: provider?.name ?? this.cfg.DATA_SOURCE,
      attribution: provider?.attribution ?? null,
      telegramMode: this.cfg.TELEGRAM_MODE,
      schedulerEnabled: this.cfg.SCHEDULER_ENABLED,
      pipelineCron: this.cfg.PIPELINE_CRON,
      nextRunAt: this.cfg.SCHEDULER_ENABLED ? nextCronRun(this.cfg.PIPELINE_CRON) : null,
      strategy: {
        name: "Two-Tier VMC strategy (Tier 1 CMC screen → Tier 2 human chart review)",
        rulesetVersion: RULESET_VERSION,
        rules: RULES,
        crawlIntervalMinutes: this.cfg.CRAWL_EXPECTED_INTERVAL_MINUTES,
        maxQuoteAgeMinutes: this.cfg.MAX_QUOTE_AGE_MINUTES,
        dailyLookbackDays: this.cfg.TIER1_DAILY_LOOKBACK_DAYS,
        venueRefreshHours: this.cfg.TIER1_VENUE_REFRESH_HOURS,
        lbank: { refreshDays: this.cfg.LBANK_PAIRS_REFRESH_DAYS, maxAgeDays: this.cfg.LBANK_PAIRS_MAX_AGE_DAYS, requireManualVerification: this.cfg.LBANK_REQUIRE_MANUAL_VERIFICATION },
        overrides,
      },
      review: { venueDecisions: VENUE_DECISIONS, eventDays: EVENT_DAYS, judgments: JUDGMENTS, candleStates: CANDLE_STATES, marketRegimes: MARKET_REGIMES, finalDecisions: FINAL_DECISIONS },
      retention: { snapshotDays: this.cfg.RETENTION_SNAPSHOT_DAYS, detailDays: this.cfg.RETENTION_DETAIL_DAYS, exportDays: this.cfg.EXPORT_RETENTION_DAYS },
      canWrite: !!this.cfg.DASHBOARD_BASIC_AUTH || LOOPBACK.has(this.cfg.HOST),
    };
  }

  @Get("overview")
  overview() {
    return this.read.overview();
  }

  @Get("scan")
  scan(@Query() q: unknown) {
    const p = parse(
      z.object({
        sheet: z.enum(["queue", "eligible", "needs_review", "excluded", "all"]).default("queue"),
        batchId: uuid.optional(),
        search: z.string().trim().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(2000).default(200),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      }),
      q,
    );
    return this.read.scanSheet({ sheet: p.sheet, batchId: p.batchId, search: p.search || undefined, limit: p.limit, offset: p.offset });
  }

  @Get("assets/:cmcId/trace")
  async trace(@Param("cmcId") id: string, @Query() q: unknown) {
    const p = parse(z.object({ batchId: uuid.optional() }), q);
    const t = await this.read.assetTrace(parse(cmcIdParam, id), p.batchId);
    if (!t) throw new NotFoundException("no Tier 1 record for this CMC id");
    return t;
  }

  @Get("assets/:cmcId/snapshots")
  snapshots(@Param("cmcId") id: string, @Query("hours") hours?: string) {
    return this.read.snapshots(parse(cmcIdParam, id), parse(z.coerce.number().int().min(1).max(720).optional(), hours) ?? 72);
  }

  @Get("assets")
  assets(@Query() q: unknown) {
    const p = parse(z.object({ search: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), q);
    return this.read.listAssets({ search: p.search, limit: p.limit, offset: p.offset });
  }

  @Get("batches")
  batches() {
    return this.read.batches(48);
  }

  @Get("health")
  async health() {
    const [coverage, runs] = await Promise.all([this.read.coverage(), this.read.runs(24)]);
    return { coverage, runs };
  }

  @Get("runs")
  runs() {
    return this.read.runs(48);
  }

  @Get("exports")
  exportsList() {
    return this.read.exportsList(48);
  }

  @Get("exports/:batchId/:file")
  async exportFile(@Param("batchId") batchId: string, @Param("file") file: string, @Res() res: Response) {
    const path = await this.read.exportFile(parse(uuid, batchId), parse(z.string().regex(/^[a-z_]+\.(csv|xlsx|json)$/), file));
    if (!path) throw new NotFoundException("export file not found");
    res.download(path, `${batchId.slice(0, 8)}_${basename(path)}`);
  }

  @Get("mapping-tasks")
  mappingTasks(@Query() q: unknown) {
    const p = parse(z.object({ status: z.enum(["OPEN", "RESOLVED", "ALL"]).default("OPEN") }), q);
    return this.read.mappingTasks(p.status, 200);
  }

  @Get("reviews")
  reviewsList(@Query() q: unknown) {
    const p = parse(z.object({ cmcId: cmcIdParam }), q);
    return this.reviews.list(this.cfg.DATA_SOURCE, p.cmcId);
  }

  @Get("reviews/:id/export")
  async reviewExport(@Param("id") id: string) {
    const r = await this.reviews.exportReview(parse(uuid, id));
    if (!r) throw new NotFoundException();
    return r;
  }

  /** Append a review revision (Tier 1 venue/event-day decision and/or Tier 2 chart review + trade plan). */
  @Post("reviews")
  createReview(@Body() body: unknown, @Req() req: Request) {
    assertTrustedWrite(req, this.cfg);
    return this.guarded(() => this.reviews.create(body));
  }

  /** Append an LBank venue decision (tradability verification or mapping evidence). */
  @Post("venue-decisions")
  venueDecision(@Body() body: unknown, @Req() req: Request) {
    assertTrustedWrite(req, this.cfg);
    return this.guarded(() => this.reviews.decideVenue(body, this.cfg.DATA_SOURCE));
  }

  /** Recompute a stored batch (default: the latest) and re-export it; never crawls. */
  @Post("scan/rescan")
  async rescan(@Body() body: unknown, @Req() req: Request) {
    assertTrustedWrite(req, this.cfg);
    const b = parse(z.object({ batchId: uuid.optional() }), body ?? {});
    const r = await this.pipeline.reprocess(b.batchId);
    if (r.skipped) return { ok: false, reason: r.skipped };
    return { ok: true, batchId: r.batchId, queueStatus: r.scan?.queueStatus, counts: r.scan?.counts, export: r.export?.status };
  }

  /** The stored LBank Spot markets list: fetch time, age, next automatic refresh, last attempt. */
  @Get("lbank")
  async lbankList() {
    return { list: await this.venues.lbankListStatus(this.cfg.DATA_SOURCE), refreshDays: this.cfg.LBANK_PAIRS_REFRESH_DAYS, maxAgeDays: this.cfg.LBANK_PAIRS_MAX_AGE_DAYS, requireManualVerification: this.cfg.LBANK_REQUIRE_MANUAL_VERIFICATION };
  }

  /** Fetch the LBank Spot markets list now, then recompute and re-export the latest batch. */
  @Post("lbank/refresh")
  async lbankRefresh(@Req() req: Request) {
    assertTrustedWrite(req, this.cfg);
    const r = await this.pipeline.refreshLbankPairs();
    if ("skipped" in r) return { ok: false, reason: r.skipped };
    return { ok: r.lbank.usable, status: r.lbank.status, pairs: r.lbank.pairs, expected: r.lbank.expected, notes: r.lbank.notes, listFetchedAt: r.lbank.listFetchedAt, nextRefreshAt: r.lbank.nextRefreshAt, batchId: r.batchId, queueStatus: r.scan?.queueStatus ?? null, counts: r.scan?.counts ?? null };
  }

  @Get("deliveries")
  deliveries() {
    return this.read.deliveries(20);
  }

  // --- Telegram access (unchanged behaviour) -------------------------------------------------

  @Get("telegram/access")
  async telegramAccess() {
    const s = await this.access.list();
    const rows = (o: Record<string, { label: string; at: string }>) => Object.entries(o).map(([chatId, e]) => ({ chatId, label: e.label, at: e.at })).sort((a, b) => b.at.localeCompare(a.at));
    return {
      owner: this.access.owner || null,
      mode: this.cfg.TELEGRAM_MODE,
      commandsEnabled: this.cfg.TELEGRAM_COMMANDS_ENABLED,
      canManage: !!this.cfg.DASHBOARD_BASIC_AUTH || LOOPBACK.has(this.cfg.HOST),
      missingCount: (await this.admin.missing(6)).length,
      members: rows(s.approved),
      pending: rows(s.pending),
      denied: s.denied,
    };
  }

  /** Reports a recipient did not receive (queued, retrying, given up, or never queued). */
  @Get("telegram/missing")
  async telegramMissing(@Query() q: unknown) {
    const p = parse(z.object({ hours: z.coerce.number().int().min(1).max(48).optional() }), q);
    const rows = await this.admin.missing(p.hours ?? 6);
    return { hours: p.hours ?? 6, mode: this.cfg.TELEGRAM_MODE, recipients: await this.admin.recipients(), rows };
  }

  @Post("telegram/retry")
  async telegramRetry(@Body() body: unknown, @Req() req: Request) {
    assertTrustedWrite(req, this.cfg);
    const b = parse(z.object({ runId: uuid.optional(), chatId: z.string().trim().max(64).optional() }), body ?? {});
    await this.assertKnownChat(b.chatId);
    return { ok: true, ...(await this.admin.retry({ runId: b.runId, chatId: b.chatId })) };
  }

  @Post("telegram/send")
  async telegramSend(@Body() body: unknown, @Req() req: Request) {
    assertTrustedWrite(req, this.cfg);
    const b = parse(z.object({ runId: uuid.optional(), chatIds: z.array(z.string().trim().max(64)).max(50).optional() }), body ?? {});
    for (const c of b.chatIds ?? []) await this.assertKnownChat(c);
    return { ok: true, ...(await this.admin.sendReport({ runId: b.runId, chatIds: b.chatIds })) };
  }

  /** Only the owner or an approved member can be a delivery target. */
  private async assertKnownChat(chatId: string | undefined) {
    if (chatId === undefined) return;
    if (!(await this.admin.recipients()).some((r) => r.chatId === chatId)) throw new BadRequestException("Unknown recipient: only the owner and approved members can receive reports.");
  }

  @Post("telegram/access/:action")
  async telegramAccessChange(@Param("action") action: string, @Body() body: unknown, @Req() req: Request) {
    assertTrustedWrite(req, this.cfg);
    const act = parse(z.enum(["approve", "reject", "remove"]), action);
    const { chatId } = parse(z.object({ chatId: z.string().trim().refine(isChatId, "chatId must be a numeric Telegram chat id") }), body);
    if (chatId === this.access.owner) throw new BadRequestException("That is the owner.");
    if (act === "approve") return { ok: true, ...(await this.admin.approve(chatId)) };
    if (act === "reject") {
      await this.admin.deny(chatId);
      return { ok: true };
    }
    return { ok: true, removed: await this.admin.remove(chatId) };
  }
}

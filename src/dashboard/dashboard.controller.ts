import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { CronTime } from "cron";
import { z } from "zod";
import { AGENT_RUNNER, type AgentRunner } from "../agents/runner.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { FEATURES } from "../features/registry.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReadModelService } from "../read-model/read-model.service.js";
import { LOOPBACK, assertTrustedWrite } from "./write-guard.js";
import { ScreeningService } from "../screening/screening.service.js";
import { TelegramAccessService, isChatId } from "../telegram/access.service.js";
import { TelegramAdminService } from "../telegram/admin.service.js";

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

const uuid = z.string().uuid();

function nextCronRun(expr: string): string | null {
  try {
    return new CronTime(expr, "UTC").sendAt().toUTC().toISO();
  } catch {
    return null;
  }
}

/** JSON API for the dashboard (reads, plus Telegram access management). The dashboard never talks to MCP. */
@Controller("api")
export class DashboardController {
  constructor(
    private readonly read: ReadModelService,
    private readonly prisma: PrismaService,
    private readonly screening: ScreeningService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    private readonly access: TelegramAccessService,
    private readonly admin: TelegramAdminService,
  ) {}

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

  @Get("config")
  async config() {
    const provider = await this.prisma.provider.findUnique({ where: { id: this.cfg.DATA_SOURCE } });
    return {
      timezone: this.cfg.DISPLAY_TIMEZONE,
      dataSource: this.cfg.DATA_SOURCE,
      isLiveData: provider?.isLive ?? this.cfg.DATA_SOURCE !== "fixture",
      providerName: provider?.name ?? this.cfg.DATA_SOURCE,
      attribution: provider?.attribution ?? null,
      agentProvider: this.cfg.AGENT_PROVIDER,
      agentAvailability: this.runner.availability(),
      models: {
        analyst: this.cfg.AGENT_MODEL_ANALYST,
        reviewer: this.cfg.AGENT_MODEL_REVIEWER,
        escalation: this.cfg.AGENT_MODEL_ESCALATION,
        coordinator: this.cfg.AGENT_MODEL_COORDINATOR,
      },
      telegramMode: this.cfg.TELEGRAM_MODE,
      snapshotWindow: this.cfg.SNAPSHOT_WINDOW,
      staleAfterMinutes: this.cfg.STALE_AFTER_MINUTES,
      candidateMinHistory: this.cfg.CANDIDATE_MIN_HISTORY,
      shortlistSize: this.cfg.SHORTLIST_SIZE,
      recommendationsMax: this.cfg.RECOMMENDATIONS_MAX,
      schedulerEnabled: this.cfg.SCHEDULER_ENABLED,
      pipelineCron: this.cfg.PIPELINE_CRON,
      nextRunAt: this.cfg.SCHEDULER_ENABLED ? nextCronRun(this.cfg.PIPELINE_CRON) : null,
      history: { maxAssetsPerRun: this.cfg.SOURCE_HISTORY_BOOTSTRAP_MAX_ASSETS, maxMinutesPerRun: this.cfg.SOURCE_HISTORY_BOOTSTRAP_MAX_MINUTES },
      retention: { snapshotDays: this.cfg.RETENTION_SNAPSHOT_DAYS, detailDays: this.cfg.RETENTION_DETAIL_DAYS },
      strategy: this.screening.strategy,
      features: FEATURES,
    };
  }

  @Get("overview")
  overview() {
    return this.read.overview();
  }

  @Get("recommendations")
  recommendations(@Query() q: unknown) {
    const p = parse(z.object({ runId: uuid.optional(), limit: z.coerce.number().int().min(1).max(25).optional() }), q);
    return this.read.recommendations({ runId: p.runId, limit: p.limit });
  }

  @Get("health")
  async health() {
    const [coverage, runs] = await Promise.all([this.read.coverage(), this.read.runs(24)]);
    return { coverage, runs };
  }

  @Get("screening")
  screeningResults(@Query() q: unknown) {
    const p = parse(
      z.object({
        runId: uuid.optional(),
        eligibleOnly: z.enum(["true", "false"]).optional(),
        classification: z.string().max(32).optional(),
        search: z.string().trim().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(5000).optional(),
        offset: z.coerce.number().int().min(0).max(100_000).optional(),
      }),
      q,
    );
    return this.read.screening({ runId: p.runId, eligibleOnly: p.eligibleOnly === "true", classification: p.classification, search: p.search || undefined, limit: p.limit ?? 100, offset: p.offset ?? 0 });
  }

  @Get("market")
  market(@Query() q: unknown) {
    const p = parse(
      z.object({
        search: z.string().trim().max(64).optional(),
        sort: z.enum(["market_cap", "volume", "change_1h", "change_24h", "change_7d", "symbol"]).optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        scope: z.enum(["all", "universe", "outside"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).max(100_000).optional(),
      }),
      q,
    );
    return this.read.market({ search: p.search || undefined, sort: p.sort ?? "market_cap", dir: p.dir ?? (p.sort === "symbol" ? "asc" : "desc"), scope: p.scope ?? "all", limit: p.limit ?? 100, offset: p.offset ?? 0 });
  }

  @Get("signals")
  signals(@Query() q: unknown) {
    const p = parse(
      z.object({
        runId: uuid.optional(),
        status: z.string().max(80).optional(),
        classification: z.string().max(32).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      q,
    );
    const status = p.status ? parse(z.array(z.enum(["candidate", "watch", "insufficient_data", "no_signal"])), p.status.split(",")) : undefined;
    return this.read.signals({ runId: p.runId, status, classification: p.classification, limit: p.limit ?? 50 });
  }

  @Get("assets")
  assets(@Query() q: unknown) {
    const p = parse(
      z.object({
        search: z.string().max(64).optional(),
        assetClass: z.string().max(16).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      q,
    );
    return this.read.listAssets({ search: p.search, assetClass: p.assetClass, limit: p.limit ?? 50, offset: p.offset ?? 0 });
  }

  @Get("assets/:id")
  async asset(@Param("id") id: string) {
    const a = await this.read.assetDetail(parse(uuid, id));
    if (!a) throw new NotFoundException();
    return a;
  }

  @Get("assets/:id/snapshots")
  snapshots(@Param("id") id: string, @Query("hours") hours?: string) {
    return this.read.snapshots(parse(uuid, id), parse(z.coerce.number().int().min(1).max(720).optional(), hours) ?? 72);
  }

  @Get("assets/:id/features")
  features(@Param("id") id: string) {
    return this.read.features(parse(uuid, id), 24);
  }

  @Get("runs")
  runs() {
    return this.read.runs(48);
  }

  @Get("runs/:id/agents")
  agents(@Param("id") id: string) {
    return this.read.agentExecutions(parse(uuid, id));
  }

  @Get("paper")
  paper() {
    return this.read.paper();
  }

  @Get("backtest")
  backtest() {
    return this.read.latestBacktest();
  }

  @Get("deliveries")
  deliveries() {
    return this.read.deliveries(20);
  }
}

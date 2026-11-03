import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { AGENT_RUNNER, type AgentRunner } from "../agents/runner.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { FEATURES } from "../features/registry.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReadModelService } from "../read-model/read-model.service.js";
import { ScreeningService } from "../screening/screening.service.js";

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

const uuid = z.string().uuid();

/** Read-only JSON API for the dashboard. The dashboard never talks to MCP. */
@Controller("api")
export class DashboardController {
  constructor(
    private readonly read: ReadModelService,
    private readonly prisma: PrismaService,
    private readonly screening: ScreeningService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
  ) {}

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
      strategy: this.screening.strategy,
      features: FEATURES,
    };
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
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      q,
    );
    return this.read.screening({ runId: p.runId, eligibleOnly: p.eligibleOnly === "true", classification: p.classification, limit: p.limit ?? 100 });
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

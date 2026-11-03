import { Inject, Injectable } from "@nestjs/common";
import { systemClock } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import type { CoverageReport } from "../ingestion/ingestion.service.js";
import { PrismaService, toNum } from "../prisma/prisma.service.js";
import { ReadModelService } from "../read-model/read-model.service.js";
import type { PaperScenario } from "../screening/scenario.js";
import { formatReport, type RecommendationRow, type ReportInput } from "./format.js";

/** Builds the Telegram report for a run from the database (the source of truth). */
@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly read: ReadModelService,
  ) {}

  /** Pump watchlist rows for the Telegram table (same data as the dashboard and MCP). */
  async watchlist(runId: string): Promise<RecommendationRow[]> {
    const rec = (await this.read.recommendations({ runId })) as { rows: Array<Record<string, any>> };
    return rec.rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      price: r.price,
      marketCap: r.marketCap,
      volume24h: r.volume24h,
      threeDayChange: r.threeDay?.change ?? null,
      threeDaySpanHours: r.threeDay?.spanHours ?? 0,
      vmcCurrent: r.vmc?.currentRatio ?? (r.volume24h !== null && r.marketCap ? r.volume24h / r.marketCap : null),
      vmcBaseline: r.vmc?.baselineMean ?? null,
      vmcMultiple: r.vmc?.multiple ?? null,
      pumpChance: r.pumpChance,
      pumpReasons: r.pumpReasons ?? [],
      agentRecommendation: r.agent?.recommendation ?? null,
      agentReason: r.agent?.reason ?? null,
      agentOrigin: r.agent?.origin ?? null,
      recommendation: r.recommendation,
      recommendationReason: r.recommendationReason ?? "",
      risk: r.riskFlags ?? [],
      scenario: r.scenario ?? undefined,
    }));
  }

  async buildInput(runId: string, agentStatus: string, summary: string | null): Promise<ReportInput> {
    const run = await this.prisma.pipelineRun.findUniqueOrThrow({ where: { id: runId } });
    const provider = await this.prisma.provider.findUniqueOrThrow({ where: { id: run.providerId } });
    const coverage = (run.coverage ?? {}) as Partial<CoverageReport>;
    const [screened, eligible, signals] = await Promise.all([
      this.prisma.screeningResult.count({ where: { runId } }),
      this.prisma.screeningResult.count({ where: { runId, eligible: true } }),
      this.prisma.signal.findMany({
        where: { runId, status: { in: ["candidate", "watch"] } },
        include: { asset: { select: { symbol: true, name: true } } },
        orderBy: [{ status: "asc" }, { heuristicScore: "desc" }],
      }),
    ]);
    const snaps = await this.prisma.marketSnapshot.findMany({
      where: { providerId: run.providerId, slotTime: run.slotTime, assetId: { in: signals.map((s) => s.assetId) } },
    });
    const snapBy = new Map(snaps.map((s) => [s.assetId, s]));
    const rows = signals.map((s) => {
      const snap = snapBy.get(s.assetId);
      const sc = s.scenario as unknown as PaperScenario;
      return {
        symbol: s.asset.symbol,
        name: s.asset.name,
        status: s.status,
        signalType: s.signalType,
        price: toNum(snap?.price),
        marketCap: toNum(snap?.marketCap),
        volume24h: toNum(snap?.volumeRolling24h),
        volumeWindow: "rolling_24h",
        score: s.heuristicScore.toNumber(),
        horizonHours: s.horizonHours,
        entry: sc.entryRule,
        invalidation: sc.stopRule,
        exit: `${sc.targetRule}; ${sc.trailingRule}; max hold ${sc.maxHoldHours}h`,
        risk: s.riskFlags,
        sourceUrl: snap?.sourceUrl ?? "",
        observedAt: snap?.observedAt?.toISOString() ?? null,
        scenario: sc.entryTriggerPrice
          ? {
              entryPrice: sc.entryTriggerPrice,
              stopPrice: sc.stopPrice,
              targetPrice: sc.targetPrice,
              trailPct: sc.trailPct,
              trailActivatePct: sc.trailActivatePct,
              maxHoldHours: sc.maxHoldHours,
              expiresAt: sc.signalExpiresAt,
            }
          : undefined,
      };
    });
    const observed = rows.map((r) => r.observedAt).filter((x): x is string => !!x).sort();
    return {
      generatedAt: systemClock.now(),
      slotTime: run.slotTime,
      timezone: this.cfg.DISPLAY_TIMEZONE,
      providerName: provider.name,
      isLive: provider.isLive,
      attribution: provider.attribution,
      coverage: {
        label: coverage.label ?? "unknown",
        collected: coverage.collected ?? 0,
        universeSize: coverage.universeSize ?? null,
        coveragePct: coverage.coveragePct ?? null,
        stale: coverage.stale ?? 0,
      },
      oldestObservedAt: observed[0] ?? null,
      agentStatus,
      summary,
      screened,
      eligible,
      rows: rows.sort((a, b) => (a.status === b.status ? b.score - a.score : a.status === "candidate" ? -1 : 1)),
      recommendations: await this.watchlist(runId),
    };
  }

  async build(runId: string, agentStatus: string, summary: string | null): Promise<string[]> {
    return formatReport(await this.buildInput(runId, agentStatus, summary));
  }
}

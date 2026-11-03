import { Inject, Injectable } from "@nestjs/common";
import { addHours } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { plain } from "./plain.js";

/**
 * Read-only queries shared by the dashboard API, the MCP server, and agent tools.
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

  async listAssets(q: { search?: string; assetClass?: string; limit: number; offset: number }) {
    const where = {
      ...(q.assetClass ? { assetClass: q.assetClass } : {}),
      ...(q.search
        ? { OR: [{ symbol: { contains: q.search.toUpperCase() } }, { name: { contains: q.search, mode: "insensitive" as const } }] }
        : {}),
      identities: { some: { providerId: this.providerId } },
    };
    const [total, rows] = await Promise.all([
      this.prisma.asset.count({ where }),
      this.prisma.asset.findMany({
        where,
        orderBy: [{ symbol: "asc" }, { id: "asc" }],
        take: q.limit,
        skip: q.offset,
        include: { identities: { select: { providerId: true, providerAssetId: true, sourceUrl: true, delistedAt: true } }, contracts: { select: { chain: true, contractAddress: true } } },
      }),
    ]);
    return plain<Record<string, unknown>>({ total, offset: q.offset, assets: rows });
  }

  async coverage() {
    const providerId = this.providerId;
    const [provider, lastRun, lastDiscovery, health, assetCount, activeIdentities] = await Promise.all([
      this.prisma.provider.findUnique({ where: { id: providerId } }),
      this.prisma.pipelineRun.findFirst({ where: { providerId }, orderBy: { slotTime: "desc" } }),
      this.prisma.discoveryRun.findFirst({ where: { providerId }, orderBy: { startedAt: "desc" } }),
      this.prisma.sourceHealth.findUnique({ where: { providerId } }),
      this.prisma.asset.count({ where: { identities: { some: { providerId } } } }),
      this.prisma.assetIdentity.count({ where: { providerId, delistedAt: null } }),
    ]);
    return plain<Record<string, unknown>>({
      provider,
      isLiveData: provider?.isLive ?? false,
      knownAssets: assetCount,
      activeIdentities,
      lastDiscovery,
      lastRunSlot: lastRun?.slotTime ?? null,
      lastRunCoverage: lastRun?.coverage ?? null,
      sourceHealth: health,
    });
  }

  async snapshots(assetId: string, hours: number) {
    const latest = await this.prisma.marketSnapshot.findFirst({ where: { assetId, providerId: this.providerId }, orderBy: { slotTime: "desc" }, select: { slotTime: true } });
    if (!latest) return plain<Record<string, unknown>>({ assetId, snapshots: [] });
    const rows = await this.prisma.marketSnapshot.findMany({
      where: { assetId, providerId: this.providerId, slotTime: { gt: addHours(latest.slotTime, -hours) } },
      orderBy: { slotTime: "asc" },
    });
    return plain<Record<string, unknown>>({ assetId, snapshots: rows });
  }

  async features(assetId: string, limit: number) {
    const rows = await this.prisma.featureValue.findMany({ where: { assetId, providerId: this.providerId }, orderBy: { slotTime: "desc" }, take: limit });
    return plain<Record<string, unknown>>({ assetId, features: rows });
  }

  async assetDetail(assetId: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId }, include: { identities: true, contracts: true } });
    return plain<Record<string, unknown> | null>(asset);
  }

  async signals(q: { status?: string[]; classification?: string; runId?: string; limit: number }) {
    const runId = q.runId ?? (await this.latestRunId());
    if (!runId) return plain<Record<string, unknown>>({ runId: null, signals: [] });
    const rows = await this.prisma.signal.findMany({
      where: { runId, ...(q.status?.length ? { status: { in: q.status } } : {}) },
      include: { asset: { select: { name: true, symbol: true, assetClass: true } }, paperPosition: true },
      orderBy: { heuristicScore: "desc" },
      take: q.limit,
    });
    const screening = await this.prisma.screeningResult.findMany({ where: { runId, assetId: { in: rows.map((r) => r.assetId) } }, select: { assetId: true, classification: true, rank: true } });
    const cls = new Map(screening.map((s) => [s.assetId, s]));
    const merged = rows
      .map((r) => ({ ...r, classification: cls.get(r.assetId)?.classification ?? null, rank: cls.get(r.assetId)?.rank ?? null }))
      .filter((r) => !q.classification || r.classification === q.classification);
    return plain<Record<string, unknown>>({ runId, signals: merged });
  }

  async screening(q: { runId?: string; eligibleOnly: boolean; classification?: string; limit: number }) {
    const runId = q.runId ?? (await this.latestRunId());
    if (!runId) return plain<Record<string, unknown>>({ runId: null, results: [] });
    const rows = await this.prisma.screeningResult.findMany({
      where: { runId, ...(q.eligibleOnly ? { eligible: true } : {}), ...(q.classification ? { classification: q.classification } : {}) },
      include: { asset: { select: { name: true, symbol: true, assetClass: true } } },
      orderBy: [{ heuristicScore: "desc" }],
      take: q.limit,
    });
    return plain<Record<string, unknown>>({ runId, results: rows });
  }

  async runs(limit: number) {
    const rows = await this.prisma.pipelineRun.findMany({
      orderBy: { slotTime: "desc" },
      take: limit,
      include: { stages: { orderBy: { startedAt: "asc" } } },
    });
    return plain<Record<string, unknown>[]>(rows);
  }

  async agentExecutions(runId: string) {
    const rows = await this.prisma.agentExecution.findMany({
      where: { runId },
      orderBy: { startedAt: "asc" },
      select: { id: true, role: true, model: true, provider: true, status: true, escalated: true, durationMs: true, numTurns: true, inputTokens: true, outputTokens: true, costUsd: true, errorKind: true, errorMessage: true, toolCalls: true },
    });
    return plain<Record<string, unknown>[]>(rows);
  }

  async paper() {
    const rows = await this.prisma.paperPosition.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { signal: { select: { slotTime: true, status: true, asset: { select: { symbol: true, name: true } } } } },
    });
    const closed = rows.filter((r) => r.status === "closed" && r.netReturn !== null);
    const net = closed.map((r) => r.netReturn!.toNumber());
    return plain<Record<string, unknown>>({
      positions: rows,
      summary: {
        total: rows.length,
        open: rows.filter((r) => r.status === "open").length,
        pendingEntry: rows.filter((r) => r.status === "pending_entry").length,
        closed: closed.length,
        expiredWithoutEntry: rows.filter((r) => r.status === "expired").length,
        winRate: net.length ? net.filter((x) => x > 0).length / net.length : null,
        avgNetReturn: net.length ? net.reduce((a, b) => a + b, 0) / net.length : null,
        ambiguousOrdering: rows.filter((r) => r.ambiguousOrdering).length,
        note: "Paper trades only. Hourly snapshots: intrahour stops/targets are unobserved.",
      },
    });
  }

  async latestBacktest() {
    return plain<Record<string, unknown> | null>(await this.prisma.backtestReport.findFirst({ orderBy: { createdAt: "desc" } }));
  }

  async deliveries(limit: number) {
    const rows = await this.prisma.telegramDelivery.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, runId: true, partIndex: true, partCount: true, mode: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true, text: true },
    });
    return plain<Record<string, unknown>[]>(rows);
  }

  async latestRunId(): Promise<string | null> {
    const r = await this.prisma.pipelineRun.findFirst({
      where: { providerId: this.providerId, stages: { some: { stage: "screen", status: "succeeded" } } },
      orderBy: { slotTime: "desc" },
      select: { id: true },
    });
    return r?.id ?? null;
  }
}

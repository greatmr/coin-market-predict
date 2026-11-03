import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { AnalysisService } from "../agents/analysis.service.js";
import { addHours, type Clock, slotOf, systemClock } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { EvaluationService } from "../evaluation/evaluation.service.js";
import { FeaturesService } from "../features/features.service.js";
import { IngestionService, type CoverageReport } from "../ingestion/ingestion.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ScreeningService } from "../screening/screening.service.js";
import { SourceUnavailableError } from "../sources/http/polite-client.js";
import { ReportService } from "../telegram/report.service.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { LeaseService } from "./lease.service.js";

export const PIPELINE_LEASE = "hourly-pipeline";
const LEASE_TTL_MS = 10 * 60_000;
const STAGES = ["discover", "collect", "features", "screen", "analyze", "publish", "notify"] as const;
type Stage = (typeof STAGES)[number];

export interface RunOutcome {
  runId: string | null;
  slot: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  reason?: string;
  stages: Partial<Record<Stage, string>>;
}

@Injectable()
export class PipelineService {
  private readonly log = new Logger(PipelineService.name);
  private inProcess = false;
  clock: Clock = systemClock;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly ingestion: IngestionService,
    private readonly features: FeaturesService,
    private readonly screening: ScreeningService,
    private readonly analysis: AnalysisService,
    private readonly evaluation: EvaluationService,
    private readonly reports: ReportService,
    private readonly telegram: TelegramService,
    private readonly leases: LeaseService,
  ) {}

  get providerId() {
    return this.ingestion.source.info.id;
  }

  /**
   * Run (or resume) the pipeline for one hourly slot. Non-overlapping within the process and,
   * through the database lease, across instances. Completed stages are skipped on resume.
   */
  async runSlot(slotInput?: Date, opts: { kind?: string; force?: boolean } = {}): Promise<RunOutcome> {
    const slot = slotOf(slotInput ?? this.clock.now());
    const kind = opts.kind ?? "hourly";
    if (this.inProcess) return { runId: null, slot: slot.toISOString(), status: "skipped", reason: "a run is already in progress in this process", stages: {} };
    const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    if (!(await this.leases.acquire(PIPELINE_LEASE, holder, LEASE_TTL_MS))) {
      return { runId: null, slot: slot.toISOString(), status: "skipped", reason: "another instance holds the pipeline lease", stages: {} };
    }
    this.inProcess = true;
    const beat = setInterval(() => void this.leases.heartbeat(PIPELINE_LEASE, holder, LEASE_TTL_MS).catch(() => undefined), 60_000);
    try {
      return await this.execute(slot, kind, !!opts.force);
    } finally {
      clearInterval(beat);
      this.inProcess = false;
      await this.leases.release(PIPELINE_LEASE, holder).catch(() => undefined);
    }
  }

  private async execute(slot: Date, kind: string, force: boolean): Promise<RunOutcome> {
    const providerId = this.providerId;
    await this.ingestion.ensureProvider();
    await this.features.ensureDefinitions();
    await this.screening.ensureStrategy();
    const now = this.clock.now();

    let run = await this.prisma.pipelineRun.findUnique({ where: { kind_slotTime_providerId: { kind, slotTime: slot, providerId } } });
    if ((run?.status === "succeeded" || run?.status === "partial") && !force) {
      return { runId: run.id, slot: slot.toISOString(), status: "skipped", reason: "slot already completed", stages: {} };
    }
    run = run
      ? await this.prisma.pipelineRun.update({ where: { id: run.id }, data: { status: "running", attempt: { increment: 1 }, error: null, finishedAt: null } })
      : await this.prisma.pipelineRun.create({
          data: { kind, slotTime: slot, providerId, status: "running", startedAt: now, isLiveData: this.ingestion.source.info.isLive },
        });
    const runId = run.id;
    const done = new Set((await this.prisma.pipelineStage.findMany({ where: { runId, status: "succeeded" } })).map((s) => s.stage));
    const stages: RunOutcome["stages"] = {};
    const metrics: Record<string, unknown> = { ...((run.metrics as Record<string, unknown>) ?? {}) };

    const stage = async <T>(name: Stage, fn: () => Promise<T>, o: { retries?: number; skipIfDone?: boolean } = {}): Promise<T | undefined> => {
      if ((o.skipIfDone ?? true) && done.has(name)) {
        stages[name] = "skipped (already done)";
        return undefined;
      }
      await this.prisma.pipelineRun.update({ where: { id: runId }, data: { currentStage: name } });
      const started = Date.now();
      await this.prisma.pipelineStage.upsert({
        where: { runId_stage: { runId, stage: name } },
        create: { runId, stage: name, status: "running", startedAt: new Date() },
        update: { status: "running", startedAt: new Date(), attempts: { increment: 1 }, error: null },
      });
      let lastErr: unknown;
      for (let attempt = 0; attempt <= (o.retries ?? 0); attempt++) {
        try {
          const result = await fn();
          await this.prisma.pipelineStage.update({
            where: { runId_stage: { runId, stage: name } },
            data: { status: "succeeded", finishedAt: new Date(), detail: summarize(result) as never },
          });
          metrics[`${name}Ms`] = Date.now() - started;
          stages[name] = "succeeded";
          return result;
        } catch (err) {
          lastErr = err;
          if (err instanceof SourceUnavailableError) break; // do not retry denied/suspended sources
        }
      }
      await this.prisma.pipelineStage.update({ where: { runId_stage: { runId, stage: name } }, data: { status: "failed", finishedAt: new Date(), error: redact(lastErr).slice(0, 2000) } });
      stages[name] = `failed: ${redact(lastErr).slice(0, 200)}`;
      throw lastErr;
    };

    let coverage = run.coverage as unknown as CoverageReport | null;
    let agentStatus = "not_run";
    let summary: string | null = null;
    try {
      await stage("discover", async () => ((await this.ingestion.discoveryDue(now)) ? this.ingestion.discover(now) : { skipped: "not due" }));
      const collected = await stage("collect", () => this.ingestion.collect(slot, runId, now), { retries: 1 });
      if (collected) coverage = collected;
      await this.prisma.pipelineRun.update({ where: { id: runId }, data: { coverage: coverage as never } });

      // Features and screening are deterministic and cheap; recompute on resume (writes are idempotent).
      const fr = (await stage("features", () => this.features.computeForSlot(providerId, slot), { skipIfDone: false }))!;
      const ranked = (await stage("screen", () => this.screening.screen(runId, providerId, fr), { skipIfDone: false }))!;
      metrics.screened = ranked.length;
      metrics.eligible = ranked.filter((r) => r.eligible).length;
      metrics.shortlisted = ranked.filter((r) => r.shortlisted).length;

      const analysis = await stage("analyze", async () => {
        const packs = await this.screening.buildEvidence(providerId, fr, ranked.filter((r) => r.shortlisted));
        const health = { ...(coverage ?? {}), sourceHealth: await this.prisma.sourceHealth.findUnique({ where: { providerId } }) };
        const out = await this.analysis.analyze(runId, slot, packs, fr.market, JSON.parse(JSON.stringify(health)));
        const packBy = new Map(packs.map((p) => [p.assetId, p]));
        await this.prisma.$transaction(
          out.finals.map((f) =>
            this.prisma.signal.upsert({
              where: { runId_assetId_strategyVersion: { runId, assetId: f.assetId, strategyVersion: this.screening.strategy.version } },
              create: {
                runId,
                assetId: f.assetId,
                slotTime: slot,
                strategyVersion: this.screening.strategy.version,
                status: f.status,
                signalType: f.signalType,
                horizonHours: f.horizonHours,
                heuristicScore: f.heuristicScore,
                agentScore: f.agentScore,
                calibratedProbability: null,
                evidence: f.evidence as never,
                counterevidence: f.counterevidence as never,
                dataQuality: f.dataQuality as never,
                entryTrigger: f.entryTrigger,
                invalidation: f.invalidation,
                exitConditions: f.exitConditions as never,
                scenario: packBy.get(f.assetId)!.scenario as never,
                expiresAt: f.expiresAt,
                rationale: f.rationale,
                riskFlags: f.riskFlags,
                origin: f.origin,
                reviewOutcome: f.reviewOutcome,
                evidenceHash: f.evidenceHash,
                isLiveData: this.ingestion.source.info.isLive,
              },
              update: {},
            }),
          ),
        );
        await this.prisma.pipelineRun.update({ where: { id: runId }, data: { modelCostUsd: out.costUsd } });
        return { agentStatus: out.agentStatus, summary: out.summary, notes: out.notes, signals: out.finals.length };
      });
      if (analysis) {
        agentStatus = analysis.agentStatus;
        summary = analysis.summary;
        metrics.agentNotes = analysis.notes;
      } else {
        const st = await this.prisma.pipelineStage.findUnique({ where: { runId_stage: { runId, stage: "analyze" } } });
        const d = (st?.detail ?? {}) as { agentStatus?: string; summary?: string | null };
        agentStatus = d.agentStatus ?? "completed";
        summary = d.summary ?? null;
      }

      await stage("publish", async () => {
        const signals = await this.prisma.signal.findMany({ where: { runId }, select: { id: true } });
        await this.prisma.signal.updateMany({ where: { runId, publishedAt: null }, data: { publishedAt: new Date() } });
        const opened = await this.evaluation.openPositions(signals.map((s) => s.id));
        const updated = await this.evaluation.updatePositions(providerId, slot);
        const outcomes = await this.evaluation.updateOutcomes(providerId, this.screening.strategy.target, slot);
        return { published: signals.length, paperOpened: opened, paperUpdated: updated, outcomesUpdated: outcomes };
      });

      await stage("notify", async () => {
        const parts = await this.reports.build(runId, agentStatus, summary);
        const prep = await this.telegram.prepare(runId, parts);
        // Live sending happens independently so delivery failures never re-run analysis.
        const sent = await this.telegram.deliverPending().catch((e) => ({ error: redact(e) }));
        return { ...prep, parts: parts.length, delivery: sent };
      });

      await this.applyRetention();
      const partial = coverage?.label !== "complete" || agentStatus === "partial" || agentStatus === "unavailable";
      await this.prisma.pipelineRun.update({ where: { id: runId }, data: { status: partial ? "partial" : "succeeded", finishedAt: new Date(), currentStage: null, metrics: metrics as never } });
      // "partial" means coverage or agent review was incomplete; the run itself finished.
      return { runId, slot: slot.toISOString(), status: partial ? "partial" : "succeeded", stages };
    } catch (err) {
      this.log.error(`run ${runId} failed: ${redact(err)}`);
      await this.prisma.pipelineRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), error: redact(err).slice(0, 2000), metrics: metrics as never } });
      return { runId, slot: slot.toISOString(), status: "failed", reason: redact(err).slice(0, 300), stages };
    }
  }

  /**
   * Restart recovery: record hours that were missed while the app was down (they cannot be
   * backfilled from a live source without real historical observations), then run the current
   * slot if the policy allows and it has not completed.
   */
  async recoverOnStartup(): Promise<{ missedRecorded: number; ran: RunOutcome | null }> {
    const providerId = this.providerId;
    const current = slotOf(this.clock.now());
    const last = await this.prisma.pipelineRun.findFirst({ where: { providerId, kind: "hourly" }, orderBy: { slotTime: "desc" } });
    let missed = 0;
    if (last) {
      for (let s = addHours(last.slotTime, 1); s < current && missed < 48; s = addHours(s, 1)) {
        const r = await this.prisma.pipelineRun.createMany({
          data: [{ kind: "hourly", slotTime: s, providerId, status: "missed", startedAt: this.clock.now(), finishedAt: this.clock.now(), isLiveData: this.ingestion.source.info.isLive, error: "application was not running during this hour" }],
          skipDuplicates: true,
        });
        missed += r.count;
      }
    }
    if (this.cfg.MISSED_RUN_POLICY === "skip") return { missedRecorded: missed, ran: null };
    const cur = await this.prisma.pipelineRun.findUnique({ where: { kind_slotTime_providerId: { kind: "hourly", slotTime: current, providerId } } });
    if (cur && (cur.status === "succeeded" || cur.status === "partial")) return { missedRecorded: missed, ran: null };
    return { missedRecorded: missed, ran: await this.runSlot(current) };
  }

  private async applyRetention() {
    if (this.cfg.RETENTION_SNAPSHOT_DAYS <= 0) return;
    const cutoff = addHours(this.clock.now(), -24 * this.cfg.RETENTION_SNAPSHOT_DAYS);
    await this.prisma.marketSnapshot.deleteMany({ where: { slotTime: { lt: cutoff } } });
    await this.prisma.featureValue.deleteMany({ where: { slotTime: { lt: cutoff } } });
  }
}

function summarize(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Map) return { size: v.size };
  if (Array.isArray(v)) return { count: v.length };
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("perAsset" in o && o.perAsset instanceof Map) return { assets: o.perAsset.size, market: o.market };
    return JSON.parse(JSON.stringify(o, (_k, val) => (typeof val === "bigint" ? Number(val) : val)));
  }
  return v;
}

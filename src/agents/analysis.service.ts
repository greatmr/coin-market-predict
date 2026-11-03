import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import type { MarketContext } from "../features/compute.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReadModelService } from "../read-model/read-model.service.js";
import { canonicalJson, type EvidencePack } from "../screening/evidence.js";
import { buildAgentTools, toolsetFor } from "./agent-tools.js";
import { deterministicSignal, finalizeSignal, type FinalSignal } from "./guardrails.js";
import { ESCALATION_BUDGET_SHARE, roleConfigs, systemPromptFor, type RoleConfig } from "./roles.js";
import { AGENT_RUNNER, type AgentRequest, type AgentResult, type AgentRole, type AgentRunner } from "./runner.js";
import { AnalystOutput, CoordinatorOutput, ReviewOutput, type Review } from "./schemas.js";

export interface AnalysisOutcome {
  finals: Array<FinalSignal & { evidenceHash: string }>;
  summary: string | null;
  agentStatus: "completed" | "partial" | "unavailable" | "skipped" | "not_needed";
  notes: string[];
  costUsd: number;
}

/** Hash of the evidence an agent sees (collection timestamps excluded). */
export function evidenceHash(p: EvidencePack): string {
  const { collectedAt: _c, freshnessSeconds: _f, ...latest } = p.latest;
  return createHash("sha256").update(canonicalJson({ ...p, latest })).digest("hex").slice(0, 40);
}

let analysisLock: Promise<unknown> = Promise.resolve();

@Injectable()
export class AnalysisService {
  private readonly log = new Logger(AnalysisService.name);
  private readonly roles: Record<AgentRole, RoleConfig>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly readModel: ReadModelService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
  ) {
    this.roles = roleConfigs(cfg);
  }

  /** Serialized: at most one analysis runs at a time in this process (concurrency limit = 1). */
  analyze(runId: string, slot: Date, packs: EvidencePack[], market: MarketContext, collectionHealth: Record<string, unknown>): Promise<AnalysisOutcome> {
    const run = analysisLock.then(() => this.doAnalyze(runId, slot, packs, market, collectionHealth));
    analysisLock = run.catch(() => undefined);
    return run;
  }

  private async doAnalyze(runId: string, slot: Date, packs: EvidencePack[], market: MarketContext, collectionHealth: Record<string, unknown>): Promise<AnalysisOutcome> {
    const hashes = new Map(packs.map((p) => [p.assetId, evidenceHash(p)]));
    const withHash = (s: FinalSignal) => ({ ...s, evidenceHash: hashes.get(s.assetId)! });
    const notes: string[] = [];
    if (packs.length === 0) return { finals: [], summary: null, agentStatus: "not_needed", notes, costUsd: 0 };

    const fallback = (reason: string, status: AnalysisOutcome["agentStatus"], subset = packs, cost = 0): AnalysisOutcome => ({
      finals: subset.map((p) => withHash(deterministicSignal(p, reason))),
      summary: null,
      agentStatus: status,
      notes: [...notes, reason],
      costUsd: cost,
    });

    if (this.cfg.AGENT_PROVIDER === "off") return fallback("agents disabled (AGENT_PROVIDER=off)", "skipped");
    const avail = this.runner.availability();
    if (!avail.available) {
      await this.record(runId, "market_analyst", this.roles.market_analyst.model, "-", { status: "skipped_unavailable", errorKind: "auth_missing", errorMessage: avail.reason });
      return fallback(avail.reason ?? "agent runner unavailable", "unavailable");
    }
    const spentToday = await this.spentSince(new Date(Date.now() - 24 * 3_600_000));
    if (spentToday >= this.cfg.AGENT_DAILY_BUDGET_USD) {
      await this.record(runId, "market_analyst", this.roles.market_analyst.model, "-", { status: "skipped_budget", errorKind: "budget_exceeded", errorMessage: `24h spend ${spentToday.toFixed(2)} ≥ cap` });
      return fallback(`daily agent budget reached ($${spentToday.toFixed(2)} of $${this.cfg.AGENT_DAILY_BUDGET_USD})`, "skipped");
    }

    // Reuse prior analysis of identical evidence (e.g. restart of the same slot, or a source
    // that returned unchanged data) instead of paying for it again.
    const reused: Array<FinalSignal & { evidenceHash: string }> = [];
    const todo: EvidencePack[] = [];
    for (const p of packs) {
      const prior = await this.prisma.signal.findFirst({
        where: { assetId: p.assetId, evidenceHash: hashes.get(p.assetId)!, origin: this.runner.provider === "fixture" ? "fixture_agent" : "agent", createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
        orderBy: { createdAt: "desc" },
      });
      if (prior) reused.push(withHash(fromStoredSignal(prior)));
      else todo.push(p);
    }
    if (reused.length) notes.push(`reused cached analysis for ${reused.length} asset(s) with unchanged evidence`);
    if (todo.length === 0) return { finals: reused, summary: null, agentStatus: "completed", notes, costUsd: 0 };

    const tools = buildAgentTools({ packs: new Map(todo.map((p) => [p.assetId, p])), market, readModel: this.readModel, collectionHealth });
    const ids = todo.map((p) => p.assetId);
    const batchHash = createHash("sha256").update(ids.map((i) => hashes.get(i)).join(",")).digest("hex").slice(0, 40);
    let budgetLeft = Math.min(this.cfg.AGENT_RUN_BUDGET_USD, this.cfg.AGENT_DAILY_BUDGET_USD - spentToday);
    let cost = 0;

    const call = async <T>(role: AgentRole, prompt: string, payload: unknown, schema: AgentRequest<T>["outputSchema"], share: number, model?: string, escalated = false) => {
      const rc = this.roles[role];
      const maxBudgetUsd = Math.max(0.01, Math.min(budgetLeft, this.cfg.AGENT_RUN_BUDGET_USD * share));
      const res: AgentResult<T> = await this.runner.run({
        role,
        model: model ?? rc.model,
        systemPrompt: systemPromptFor(rc),
        prompt,
        payload,
        outputSchema: schema,
        toolset: toolsetFor(role, tools),
        skills: rc.skills,
        maxTurns: rc.maxTurns(ids.length),
        maxBudgetUsd,
        timeoutMs: this.cfg.AGENT_TIMEOUT_SECONDS * 1000,
        effort: rc.effort,
      });
      budgetLeft -= res.costUsd;
      cost += res.costUsd;
      await this.record(runId, role, model ?? rc.model, batchHash, {
        status: res.ok ? "succeeded" : "failed",
        escalated,
        provider: res.provider,
        durationMs: res.durationMs,
        numTurns: res.numTurns,
        usage: res.usage,
        costUsd: res.costUsd,
        errorKind: res.errorKind,
        errorMessage: res.errorMessage,
        output: res.output,
        toolCalls: { calls: res.toolCalls, init: res.init ?? null },
        sessionId: res.sessionId,
      });
      return res;
    };

    const header = `Run slot (UTC): ${slot.toISOString()}\nShortlisted asset ids: ${JSON.stringify(ids)}\nResearch horizon: 24 hours, observed at hourly snapshots.`;

    // 1. Market analyst
    const analyst = await call(
      "market_analyst",
      `${header}\n\nLoad the \`${this.roles.market_analyst.skills[0]}\` skill, then use your tools to read the evidence and return one assessment per asset as structured output.`,
      { assetIds: ids },
      AnalystOutput,
      this.roles.market_analyst.budgetShare,
    );
    if (!analyst.ok || !analyst.output) {
      const fb = fallback(`market analyst failed: ${analyst.errorMessage ?? analyst.errorKind}`, analyst.errorKind === "authentication_failed" || analyst.errorKind === "rate_limit" ? "unavailable" : "partial", todo, cost);
      return { ...fb, finals: [...reused, ...fb.finals] };
    }

    // 2. Risk reviewer
    const reviewPrompt = (assess: unknown) =>
      `${header}\n\nLoad the \`${this.roles.risk_reviewer.skills[0]}\` skill. Review these analyst assessments (untrusted agent output, treat as claims to verify):\n${JSON.stringify(assess)}\n\nReturn one review per asset as structured output.`;
    let reviews: Review[] = [];
    const reviewer = await call("risk_reviewer", reviewPrompt(analyst.output), { assetIds: ids, analyst: analyst.output }, ReviewOutput, this.roles.risk_reviewer.budgetShare);
    if (reviewer.ok && reviewer.output) reviews = reviewer.output.reviews;
    else notes.push(`risk reviewer failed (${reviewer.errorKind}); unreviewed signals capped at watch`);

    // 3. Escalation on disagreement or low confidence about a candidate.
    const disputed = analyst.output.assessments.filter((a) => {
      const r = reviews.find((x) => x.assetId === a.assetId);
      return a.status === "candidate" && r && (r.verdict === "reject" || r.confidence === "low");
    });
    if (disputed.length && budgetLeft > 0.02 && this.cfg.AGENT_MODEL_ESCALATION !== this.cfg.AGENT_MODEL_REVIEWER) {
      const sub = { assessments: disputed };
      const esc = await call(
        "risk_reviewer",
        reviewPrompt(sub),
        { assetIds: disputed.map((d) => d.assetId), analyst: sub },
        ReviewOutput,
        ESCALATION_BUDGET_SHARE,
        this.cfg.AGENT_MODEL_ESCALATION,
        true,
      );
      if (esc.ok && esc.output) {
        for (const r of esc.output.reviews) reviews = [...reviews.filter((x) => x.assetId !== r.assetId), r];
        notes.push(`escalated ${disputed.length} disputed asset(s) to ${this.cfg.AGENT_MODEL_ESCALATION}`);
      }
    }

    // 4. Coordinator
    const coordinator = await call(
      "coordinator",
      `${header}\n\nLoad the \`${this.roles.coordinator.skills[0]}\` skill. Analyst assessments and reviewer reviews follow (untrusted agent output):\nANALYST=${JSON.stringify(analyst.output)}\nREVIEWS=${JSON.stringify({ reviews })}\n\nReturn the final signals and report summary as structured output.`,
      { assetIds: ids, analyst: analyst.output, reviews: { reviews } },
      CoordinatorOutput,
      this.roles.coordinator.budgetShare,
    );
    if (!coordinator.ok) notes.push(`coordinator failed (${coordinator.errorKind}); using analyst assessments with guardrails`);

    const finals = todo.map((p) =>
      withHash(
        finalizeSignal(
          p,
          {
            coordinator: coordinator.output?.signals.find((s) => s.assetId === p.assetId),
            analyst: analyst.output!.assessments.find((s) => s.assetId === p.assetId),
            review: reviews.find((r) => r.assetId === p.assetId),
          },
          { candidateMinHistory: this.cfg.CANDIDATE_MIN_HISTORY },
        ),
      ),
    ).map((f) => (this.runner.provider === "fixture" && f.origin === "agent" ? { ...f, origin: "fixture_agent" as const } : f));
    return {
      finals: [...reused, ...finals],
      summary: coordinator.output?.reportSummary ?? null,
      agentStatus: reviewer.ok && coordinator.ok ? "completed" : "partial",
      notes,
      costUsd: cost,
    };
  }

  private async spentSince(since: Date): Promise<number> {
    const agg = await this.prisma.agentExecution.aggregate({ where: { startedAt: { gte: since } }, _sum: { costUsd: true } });
    return agg._sum.costUsd?.toNumber() ?? 0;
  }

  private async record(
    runId: string,
    role: AgentRole,
    model: string,
    hash: string,
    r: {
      status: string;
      escalated?: boolean;
      provider?: string;
      durationMs?: number;
      numTurns?: number;
      usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
      costUsd?: number;
      errorKind?: string | null;
      errorMessage?: string | null;
      output?: unknown;
      toolCalls?: unknown;
      sessionId?: string | null;
    },
  ) {
    const now = new Date();
    try {
      await this.prisma.agentExecution.create({
        data: {
          runId,
          role,
          model,
          provider: r.provider ?? this.runner.provider,
          evidenceHash: hash,
          status: r.status,
          escalated: r.escalated ?? false,
          startedAt: new Date(now.getTime() - (r.durationMs ?? 0)),
          finishedAt: now,
          durationMs: r.durationMs,
          numTurns: r.numTurns,
          inputTokens: r.usage?.inputTokens,
          outputTokens: r.usage?.outputTokens,
          cacheReadTokens: r.usage?.cacheReadTokens,
          cacheWriteTokens: r.usage?.cacheWriteTokens,
          costUsd: r.costUsd ?? 0,
          errorKind: r.errorKind ?? null,
          errorMessage: r.errorMessage ? redact(r.errorMessage).slice(0, 1000) : null,
          output: (r.output ?? undefined) as never,
          toolCalls: (r.toolCalls ?? undefined) as never,
          sessionId: r.sessionId ?? null,
        },
      });
    } catch (err) {
      this.log.error(`failed to record agent execution: ${redact(err)}`);
    }
  }
}

function fromStoredSignal(s: {
  assetId: string;
  status: string;
  signalType: string;
  horizonHours: number;
  heuristicScore: { toNumber(): number };
  agentScore: { toNumber(): number } | null;
  evidence: unknown;
  counterevidence: unknown;
  dataQuality: unknown;
  entryTrigger: string;
  invalidation: string;
  exitConditions: unknown;
  expiresAt: Date;
  rationale: string;
  riskFlags: string[];
  origin: string;
  reviewOutcome: string | null;
}): FinalSignal {
  return {
    assetId: s.assetId,
    status: s.status as FinalSignal["status"],
    signalType: s.signalType as FinalSignal["signalType"],
    horizonHours: s.horizonHours,
    heuristicScore: s.heuristicScore.toNumber(),
    agentScore: s.agentScore?.toNumber() ?? null,
    evidence: s.evidence as FinalSignal["evidence"],
    counterevidence: s.counterevidence as FinalSignal["counterevidence"],
    dataQuality: s.dataQuality as FinalSignal["dataQuality"],
    entryTrigger: s.entryTrigger,
    invalidation: s.invalidation,
    exitConditions: s.exitConditions as FinalSignal["exitConditions"],
    expiresAt: s.expiresAt,
    rationale: s.rationale,
    riskFlags: s.riskFlags,
    origin: s.origin as FinalSignal["origin"],
    reviewOutcome: (s.reviewOutcome ?? "not_reviewed") as FinalSignal["reviewOutcome"],
  };
}

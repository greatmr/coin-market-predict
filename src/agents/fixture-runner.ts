import type { EvidencePack } from "../screening/evidence.js";
import { emptyUsage, type AgentRequest, type AgentResult, type AgentRunner } from "./runner.js";
import type { AnalystOutput, AssetAssessment, CoordinatorOutput, Review, ReviewOutput } from "./schemas.js";

/**
 * Deterministic OFFLINE stand-in for the Claude agents. It makes no model calls; it applies
 * fixed rules to the same evidence (fetched through the same role-scoped tools) and returns
 * outputs that go through the same schema validation and guardrails. Executions are recorded
 * with provider "fixture" so they are never mistaken for model analysis.
 */
export class FixtureAgentRunner implements AgentRunner {
  readonly provider = "fixture" as const;

  availability() {
    return { available: true, reason: null };
  }

  async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    const started = Date.now();
    const payload = req.payload as { assetIds: string[]; analyst?: AnalystOutput; reviews?: ReviewOutput };
    const toolCalls: AgentResult<T>["toolCalls"] = [];
    const packs: EvidencePack[] = [];
    for (const id of payload.assetIds) {
      const r = await req.toolset.call("get_evidence", { assetId: id });
      toolCalls.push({ name: "mcp__coins__get_evidence", allowed: !r.isError });
      if (!r.isError) packs.push((r.structuredContent as { data: EvidencePack }).data);
    }

    let raw: unknown;
    if (req.role === "market_analyst") raw = { assessments: packs.map(analyze) } satisfies AnalystOutput;
    else if (req.role === "risk_reviewer") raw = { reviews: packs.map(review) } satisfies ReviewOutput;
    else raw = coordinate(packs, payload.analyst, payload.reviews);

    const parsed = req.outputSchema.safeParse(raw);
    return {
      ok: parsed.success,
      output: parsed.success ? parsed.data : null,
      errorKind: parsed.success ? null : "invalid_output",
      errorMessage: parsed.success ? null : parsed.error.message.slice(0, 500),
      usage: emptyUsage(),
      costUsd: 0,
      durationMs: Date.now() - started,
      numTurns: 1,
      sessionId: null,
      toolCalls,
      provider: this.provider,
    };
  }
}

const SEVERE = new Set(["volume_exceeds_market_cap", "possible_wash_trading", "provider_timing_mismatch"]);

function analyze(p: EvidencePack): AssetAssessment {
  const observedAt = p.latest.observedAt ?? p.latest.slotTime;
  const evidence = ["ret_2h", "accel_1h", "vol24_change_2h", "rs_market_2h", "vol_mcap", "breakout_24h"]
    .filter((m) => p.features[m] !== null && p.features[m] !== undefined)
    .slice(0, 5)
    .map((m) => ({ metric: m, value: p.features[m]!, observedAt, interpretation: `${m} = ${p.features[m]!.toFixed(4)} (from evidence pack)` }));
  const status =
    p.warmupState === "warming_up" ? "insufficient_data" : p.screening.classification === "advance_candidate" ? "candidate" : "watch";
  return {
    assetId: p.assetId,
    status,
    signalType: p.screening.classification === "advance_candidate" ? "advance" : p.screening.classification === "move_underway" ? "move_underway" : "none",
    horizonHours: 24,
    score: p.screening.heuristicScore,
    evidence,
    counterevidence: [
      ...p.screening.riskFlags.slice(0, 5).map((f) => ({ point: `risk flag: ${f}`, metric: null })),
      ...Object.keys(p.unavailableFeatures).slice(0, 2).map((k) => ({ point: `${k} unavailable: ${p.unavailableFeatures[k]}`, metric: k })),
    ].slice(0, 8),
    dataQuality: {
      assessment: p.latest.qualityFlags.length === 0 ? "good" : "degraded",
      issues: p.latest.qualityFlags.slice(0, 8),
      missing: Object.keys(p.latest.nullReasons).slice(0, 16),
    },
    entryTrigger: p.scenario.entryRule.slice(0, 300),
    invalidation: p.scenario.stopRule.slice(0, 300),
    exitConditions: { target: p.scenario.targetRule.slice(0, 200), trailing: p.scenario.trailingRule.slice(0, 200), maxHoldingHours: p.scenario.maxHoldHours },
    expiresAt: p.scenario.signalExpiresAt,
    rationale: `[fixture analyst] ${p.screening.classification} with heuristic score ${p.screening.heuristicScore.toFixed(1)}; history ${p.historyDepth}h (${p.warmupState}).`,
    ...stance(p),
  };
}

/** Deterministic stand-in for the agents' own buy / hold / sell view. */
function stance(p: EvidencePack): Pick<AssetAssessment, "recommendation" | "recommendationReason"> {
  if (p.screening.riskFlags.some((f) => SEVERE.has(f))) return { recommendation: "sell", recommendationReason: "[fixture] manipulation-like risk flags: avoid." };
  if (p.warmupState === "warming_up") return { recommendation: "hold", recommendationReason: "[fixture] not enough consecutive hourly history yet." };
  if (p.pump.chance === "low") return { recommendation: "sell", recommendationReason: "[fixture] strategy pump chance is low." };
  if (p.pump.chance === "high" && p.screening.classification === "advance_candidate") {
    return { recommendation: "buy", recommendationReason: "[fixture] clean early-surge setup; paper entry only if the trigger prints." };
  }
  return { recommendation: "hold", recommendationReason: `[fixture] ${p.pump.chance} pump chance (${p.screening.classification}); wait for confirmation.` };
}

function review(p: EvidencePack): Review {
  const severe = p.screening.riskFlags.filter((f) => SEVERE.has(f));
  if (severe.length) {
    return { assetId: p.assetId, verdict: "reject", recommendedStatus: "no_signal", confidence: "high", concerns: severe.map((s) => `severe risk: ${s}`), failureConditions: ["manipulation-like volume can reverse abruptly"], dataQualityIssues: p.latest.qualityFlags.slice(0, 8) };
  }
  const soft = p.screening.riskFlags.filter((f) => f === "thin_history" || f === "micro_cap");
  if (soft.length || p.warmupState !== "full") {
    return { assetId: p.assetId, verdict: "downgrade", recommendedStatus: p.warmupState === "warming_up" ? "insufficient_data" : "watch", confidence: "medium", concerns: soft.map((s) => `risk: ${s}`), failureConditions: ["move fades within the next hourly snapshots"], dataQualityIssues: [] };
  }
  return { assetId: p.assetId, verdict: "agree", recommendedStatus: p.screening.classification === "advance_candidate" ? "candidate" : "watch", confidence: "medium", concerns: [], failureConditions: ["price closes below the invalidation level"], dataQualityIssues: [] };
}

function coordinate(packs: EvidencePack[], analyst?: AnalystOutput, reviews?: ReviewOutput): CoordinatorOutput {
  const signals = packs.map((p) => {
    const a = analyst?.assessments.find((x) => x.assetId === p.assetId) ?? analyze(p);
    const r = reviews?.reviews.find((x) => x.assetId === p.assetId);
    const rec = r?.verdict === "reject" ? "sell" : r?.verdict === "downgrade" && a.recommendation === "buy" ? "hold" : a.recommendation;
    const recReason = rec === a.recommendation ? a.recommendationReason : `[fixture coordinator] reviewer ${r?.verdict}: ${rec}.`;
    return { ...a, status: r && r.verdict !== "agree" ? r.recommendedStatus : a.status, rationale: `[fixture coordinator] ${a.rationale} Review: ${r?.verdict ?? "none"}.`.slice(0, 800), recommendation: rec, recommendationReason: recReason };
  });
  const n = signals.filter((s) => s.status === "candidate").length;
  return { signals, reportSummary: `Fixture analysis of ${packs.length} shortlisted assets; ${n} candidate(s). Synthetic data, not market advice.` };
}

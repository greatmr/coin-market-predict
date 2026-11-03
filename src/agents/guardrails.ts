import type { EvidencePack } from "../screening/evidence.js";
import type { AssetAssessment, Review, SignalStatus } from "./schemas.js";

/** Final, validated signal ready to persist. */
export interface FinalSignal {
  assetId: string;
  status: SignalStatus;
  signalType: "advance" | "move_underway" | "none";
  horizonHours: number;
  heuristicScore: number;
  agentScore: number | null;
  evidence: AssetAssessment["evidence"];
  counterevidence: AssetAssessment["counterevidence"];
  dataQuality: AssetAssessment["dataQuality"] & { guardrailNotes: string[] };
  entryTrigger: string;
  invalidation: string;
  exitConditions: AssetAssessment["exitConditions"];
  expiresAt: Date;
  rationale: string;
  riskFlags: string[];
  /** agent = Claude Agent SDK; fixture_agent = offline deterministic stand-in; deterministic = no agent. */
  origin: "agent" | "fixture_agent" | "deterministic";
  reviewOutcome: "agree" | "downgrade" | "reject" | "not_reviewed";
}

const RANK: Record<SignalStatus, number> = { no_signal: 0, insufficient_data: 1, watch: 2, candidate: 3 };

function minStatus(...xs: Array<SignalStatus | undefined>): SignalStatus {
  return xs.filter((x): x is SignalStatus => !!x).reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

function lookup(pack: EvidencePack, metric: string): number | null | undefined {
  const m = metric.replace(/^features\./, "");
  if (m in pack.features) return pack.features[m];
  const latestKey = m.replace(/^latest\./, "") as keyof EvidencePack["latest"];
  const v = pack.latest[latestKey];
  if (typeof v === "number") return v;
  if (m === "heuristicScore" || m === "screening.heuristicScore") return pack.screening.heuristicScore;
  return undefined;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-4);
}

/** Keep only evidence items that cite a supplied metric, its supplied value, and a supplied timestamp. */
export function verifyEvidence(pack: EvidencePack, items: AssetAssessment["evidence"]) {
  const times = new Set(
    [pack.latest.observedAt, pack.latest.slotTime, ...pack.recentSnapshots.flatMap((s) => [s.observedAt, s.slotTime])]
      .filter((t): t is string => !!t)
      .map((t) => new Date(t).getTime()),
  );
  const kept: AssetAssessment["evidence"] = [];
  const notes: string[] = [];
  for (const e of items) {
    const v = lookup(pack, e.metric);
    if (v === undefined) {
      notes.push(`dropped evidence: unknown metric "${e.metric}"`);
      continue;
    }
    if (v === null || e.value === null || !close(e.value, v)) {
      notes.push(`dropped evidence: ${e.metric} value does not match supplied evidence`);
      continue;
    }
    const t = new Date(e.observedAt).getTime();
    if (!times.has(t)) {
      notes.push(`dropped evidence: ${e.metric} cites a timestamp not in the evidence`);
      continue;
    }
    kept.push(e);
  }
  return { kept, notes };
}

export interface GuardrailOptions {
  candidateMinHistory: number;
}

/**
 * Combine analyst, reviewer, and coordinator outputs with deterministic ceilings.
 * The most conservative status wins; agreement between agents never raises a status.
 */
export function finalizeSignal(
  pack: EvidencePack,
  input: { coordinator?: AssetAssessment; analyst?: AssetAssessment; review?: Review },
  opts: GuardrailOptions,
): FinalSignal {
  const base = input.coordinator ?? input.analyst;
  if (!base) return deterministicSignal(pack, "agent output missing for this asset");
  const notes: string[] = [];
  const { kept, notes: evNotes } = verifyEvidence(pack, base.evidence);
  notes.push(...evNotes);

  let status = minStatus(base.status, input.analyst?.status, input.review?.recommendedStatus);
  if (input.review?.verdict === "reject") status = minStatus(status, "no_signal");
  if (input.review?.verdict === "downgrade") status = minStatus(status, "watch");
  if (!input.review) {
    status = minStatus(status, "watch");
    notes.push("not reviewed by risk reviewer: capped at watch");
  }
  if (pack.warmupState === "warming_up") {
    status = "insufficient_data";
    notes.push("warm-up: fewer than the configured snapshot window");
  }
  if (status === "candidate" && pack.historyDepth < opts.candidateMinHistory) {
    status = "watch";
    notes.push(`history ${pack.historyDepth}h < ${opts.candidateMinHistory}h required for candidate status`);
  }
  if (status === "candidate" && kept.length === 0) {
    status = "watch";
    notes.push("no verifiable supporting evidence: capped at watch");
  }
  if (status === "candidate" && base.dataQuality.assessment === "poor") {
    status = "watch";
    notes.push("poor data quality: capped at watch");
  }

  // Agents cannot relabel detection of a move already underway as an advance signal.
  const cls = pack.screening.classification;
  const signalType = cls === "move_underway" ? "move_underway" : cls === "advance_candidate" ? base.signalType : "none";

  const maxExpiry = new Date(pack.scenario.signalExpiresAt);
  const proposed = new Date(base.expiresAt);
  const expiresAt = Number.isNaN(proposed.getTime()) || proposed > maxExpiry ? maxExpiry : proposed;

  return {
    assetId: pack.assetId,
    status,
    signalType,
    horizonHours: Math.min(base.horizonHours, pack.scenario.maxHoldHours),
    heuristicScore: pack.screening.heuristicScore,
    agentScore: base.score,
    evidence: kept,
    counterevidence: [
      ...base.counterevidence,
      ...(input.review?.concerns ?? []).map((c) => ({ point: `reviewer: ${c}`, metric: null })),
      ...(input.review?.failureConditions ?? []).map((c) => ({ point: `failure condition: ${c}`, metric: null })),
    ].slice(0, 16),
    dataQuality: { ...base.dataQuality, issues: [...base.dataQuality.issues, ...(input.review?.dataQualityIssues ?? [])].slice(0, 12), guardrailNotes: notes },
    entryTrigger: base.entryTrigger,
    invalidation: base.invalidation,
    exitConditions: { ...base.exitConditions, maxHoldingHours: Math.min(base.exitConditions.maxHoldingHours, pack.scenario.maxHoldHours) },
    expiresAt,
    rationale: base.rationale,
    riskFlags: pack.screening.riskFlags,
    origin: "agent",
    reviewOutcome: input.review?.verdict ?? "not_reviewed",
  };
}

/** Signal produced without agent analysis (agents off/unavailable). Never above "watch". */
export function deterministicSignal(pack: EvidencePack, reason: string): FinalSignal {
  const observedAt = pack.latest.observedAt ?? pack.latest.slotTime;
  const evidence = ["ret_2h", "accel_1h", "vol24_change_2h", "rs_market_2h"]
    .filter((m) => typeof pack.features[m] === "number")
    .map((m) => ({ metric: m, value: pack.features[m]!, observedAt, interpretation: "deterministic screen input" }));
  return {
    assetId: pack.assetId,
    status: pack.warmupState === "warming_up" ? "insufficient_data" : "watch",
    signalType: pack.screening.classification === "advance_candidate" ? "advance" : pack.screening.classification === "move_underway" ? "move_underway" : "none",
    horizonHours: pack.scenario.maxHoldHours,
    heuristicScore: pack.screening.heuristicScore,
    agentScore: null,
    evidence,
    counterevidence: pack.screening.riskFlags.map((f) => ({ point: `risk flag: ${f}`, metric: null })),
    dataQuality: {
      assessment: pack.latest.qualityFlags.length ? "degraded" : "good",
      issues: pack.latest.qualityFlags,
      missing: Object.keys(pack.latest.nullReasons),
      guardrailNotes: [`agent analysis unavailable: ${reason}`],
    },
    entryTrigger: pack.scenario.entryRule,
    invalidation: pack.scenario.stopRule,
    exitConditions: { target: pack.scenario.targetRule, trailing: pack.scenario.trailingRule, maxHoldingHours: pack.scenario.maxHoldHours },
    expiresAt: new Date(pack.scenario.signalExpiresAt),
    rationale: `Deterministic screen only (${pack.screening.classification}); not reviewed by agents.`,
    riskFlags: pack.screening.riskFlags,
    origin: "deterministic",
    reviewOutcome: "not_reviewed",
  };
}

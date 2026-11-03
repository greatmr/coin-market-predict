import type { Classification } from "./screen.js";
import type { StrategyParams } from "./strategy.js";

/**
 * Strategy pump chance and the combined (strategy + agents) recommendation. Pure functions so
 * the screen, evidence packs, dashboard, MCP and Telegram all show the same thing.
 *
 * "Pump chance" is a heuristic LEVEL that ranks research hypotheses from the deterministic
 * screen. It is not a probability, and "buy" means "take the paper-trading entry if the entry
 * trigger prints" — no real orders exist anywhere in this system.
 */

export type PumpChance = "high" | "medium" | "low";
export const PUMP_RANK: Readonly<Record<PumpChance, number>> = { high: 2, medium: 1, low: 0 };
/** Score from which a clean advance setup counts as a high pump chance. */
export const HIGH_PUMP_SCORE = 50;

export type AgentRecommendation = "buy" | "hold" | "sell";
export type Recommendation = "buy" | "watch" | "avoid";

/** Risk flags that rule out a pump call whatever the pattern (manipulation-like volume). */
const DISQUALIFYING: Readonly<Record<string, string>> = {
  possible_wash_trading: "possible wash trading",
  volume_exceeds_market_cap: "24h volume above market cap",
};
const CAUTION: Readonly<Record<string, string>> = {
  micro_cap: "micro cap",
  thin_history: "short history",
  extreme_1h_move: "extreme 1h move",
  price_up_without_volume: "price up without volume",
  large_fdv_overhang: "large FDV overhang",
  provider_timing_mismatch: "data timing mismatch",
};
const EXCLUSION_TEXT: Readonly<Record<string, string>> = {
  warming_up: "warming up (fewer than 3 hourly snapshots)",
  illiquid_volume: "24h volume below the floor",
  below_min_market_cap: "market cap below the floor",
  market_cap_unavailable: "no circulating market cap",
  benchmark_reference: "BTC/ETH benchmark",
  stale_observation: "stale quote",
  incomplete_data: "price or volume missing",
  no_current_snapshot: "not collected this hour",
};

const sign = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "");
const pct = (x: number, dp = 1) => `${sign(x)}${Math.abs(x * 100).toFixed(dp)}%`;
const pp = (x: number) => `${sign(x)}${Math.abs(x * 100).toFixed(1)} pp`;

export interface PumpInput {
  eligible: boolean;
  exclusionReasons: string[];
  classification: Classification;
  heuristicScore: number;
  riskFlags: string[];
  features: Record<string, number | null | undefined>;
}

export interface PumpAssessment {
  chance: PumpChance;
  /** Plain-language reasons, most important first. */
  reasons: string[];
  /** How many of the four early-surge conditions hold (volume build, acceleration, 2h move, relative strength). */
  setupChecks: number;
}

export function pumpChance(i: PumpInput, p: StrategyParams): PumpAssessment {
  const num = (k: string) => {
    const x = i.features[k];
    return typeof x === "number" && Number.isFinite(x) ? x : null;
  };
  const vb = num("vol24_change_2h"), acc = num("accel_1h"), r2 = num("ret_2h"), rs = num("rs_market_2h");
  const checks = [
    vb !== null && vb >= p.advanceMinVolumeBuild
      ? { ok: true, text: `volume building ${pct(vb)} in 2h (≥ ${pct(p.advanceMinVolumeBuild, 0)})` }
      : { ok: false, text: vb === null ? "volume build unknown" : `volume not building (${pct(vb)} vs ≥ ${pct(p.advanceMinVolumeBuild, 0)})` },
    acc !== null && acc > 0 ? { ok: true, text: `price accelerating (${pp(acc)})` } : { ok: false, text: acc === null ? "acceleration unknown" : `not accelerating (${pp(acc)})` },
    r2 !== null && r2 >= p.advanceMinRet2h ? { ok: true, text: `up ${pct(r2)} in 2h` } : { ok: false, text: r2 === null ? "2h return unknown" : `2h return ${pct(r2)} below ${pct(p.advanceMinRet2h)}` },
    rs === null ? { ok: true, text: "market median unavailable (relative strength not tested)" } : rs > 0 ? { ok: true, text: `ahead of the market (${pp(rs)} over 2h)` } : { ok: false, text: `lagging the market (${pp(rs)} over 2h)` },
  ];
  const met = checks.filter((c) => c.ok).length;
  if (!i.eligible) {
    const why = i.exclusionReasons.map((r) => (r.startsWith("excluded_class:") ? r.slice(15) : EXCLUSION_TEXT[r] ?? r.replace(/_/g, " ")));
    return { chance: "low", reasons: [`not eligible: ${why.join(", ")}`], setupChecks: met };
  }

  let chance: PumpChance;
  let lead: string;
  switch (i.classification) {
    case "advance_candidate":
      chance = i.heuristicScore >= HIGH_PUMP_SCORE ? "high" : "medium";
      lead = `early-surge setup: all conditions met (score ${Math.round(i.heuristicScore)})`;
      break;
    case "move_underway":
      chance = i.heuristicScore >= HIGH_PUMP_SCORE ? "medium" : "low";
      lead = `move already underway (≥ ${pct(p.underwayRet2h, 0)} in 2h): detection, entry would be late`;
      break;
    case "overextended":
      chance = "low";
      lead = "overextended: moved too far already";
      break;
    case "market_wide":
      chance = "low";
      lead = "moving with a broad market rally, little relative strength";
      break;
    case "gradual_trend":
      chance = "low";
      lead = "steady gradual climb, not a surge";
      break;
    default:
      chance = met >= 3 && i.heuristicScore >= p.minShortlistScore ? "medium" : "low";
      lead = met >= 3 ? `setup forming: ${met} of 4 early-surge conditions met` : "no surge pattern this hour";
  }
  const reasons = [lead, ...checks.filter((c) => c.ok).map((c) => `✓ ${c.text}`), ...checks.filter((c) => !c.ok).map((c) => `✗ ${c.text}`)];
  const disq = i.riskFlags.filter((f) => f in DISQUALIFYING);
  if (disq.length) {
    chance = "low";
    reasons.unshift(`ruled out: ${disq.map((f) => DISQUALIFYING[f]).join(", ")}`);
  }
  const caution = i.riskFlags.filter((f) => f in CAUTION).map((f) => CAUTION[f]);
  if (caution.length) reasons.push(`caution: ${caution.join(", ")}`);
  return { chance, reasons: reasons.slice(0, 8), setupChecks: met };
}

export interface CombineInput {
  pumpChance: PumpChance | null;
  /** Final status after agent review and guardrails. */
  status: "candidate" | "watch" | "insufficient_data" | "no_signal";
  agentRecommendation: AgentRecommendation | null;
  reviewOutcome: string | null;
}

/**
 * Combined recommendation. Conservative by construction: "buy" needs the strategy (high or
 * medium pump chance), the guardrailed status (candidate) and the agents (buy) to agree; any
 * agent "sell", review rejection, low chance or missing data means "avoid".
 */
export function combineRecommendation(c: CombineInput): { recommendation: Recommendation; reason: string } {
  if (c.agentRecommendation === "sell") return { recommendation: "avoid", reason: "agents recommend selling/avoiding this setup" };
  if (c.reviewOutcome === "reject" || c.status === "no_signal") return { recommendation: "avoid", reason: "risk review rejected the setup" };
  if (c.status === "insufficient_data") return { recommendation: "avoid", reason: "not enough consecutive hourly data to judge" };
  if (!c.pumpChance || c.pumpChance === "low") return { recommendation: "avoid", reason: "strategy pump chance is low" };
  if (!c.agentRecommendation) return { recommendation: "watch", reason: `strategy pump chance ${c.pumpChance}, not reviewed by agents` };
  if (c.agentRecommendation === "buy" && c.status === "candidate") {
    return { recommendation: "buy", reason: `strategy (${c.pumpChance} pump chance) and agents agree; paper entry only if the entry trigger prints` };
  }
  if (c.agentRecommendation === "buy") return { recommendation: "watch", reason: `agents lean buy, but guardrails cap the setup at ${c.status}` };
  return { recommendation: "watch", reason: `strategy pump chance ${c.pumpChance}; agents say hold and wait for confirmation` };
}

/** Order for recommendation lists: chance, then score. */
export function byPumpChance<T extends { pumpChance: PumpChance; heuristicScore: number; assetId: string }>(a: T, b: T): number {
  return PUMP_RANK[b.pumpChance] - PUMP_RANK[a.pumpChance] || b.heuristicScore - a.heuristicScore || a.assetId.localeCompare(b.assetId);
}

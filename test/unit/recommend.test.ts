import { describe, expect, it } from "vitest";
import { deterministicSignal, finalizeSignal, verifyEvidence } from "../../src/agents/guardrails.js";
import type { AssetAssessment, Review } from "../../src/agents/schemas.js";
import { AssetAssessment as AssessmentSchema, ExternalAssessment } from "../../src/agents/schemas.js";
import { threeDayStats, vmcContext } from "../../src/screening/context.js";
import { byPumpChance, combineRecommendation, HIGH_PUMP_SCORE, pumpChance, type PumpInput } from "../../src/screening/recommend.js";
import { defaultStrategy } from "../../src/screening/strategy.js";
import { formatReport, recTable, type RecommendationRow, type ReportInput } from "../../src/telegram/format.js";
import { ASSET_ID, makePack, OBSERVED } from "../helpers/pack.js";

const p = defaultStrategy();
const early = { vol24_change_2h: 0.4, accel_1h: 0.01, ret_2h: 0.03, rs_market_2h: 0.02 };
const pin = (over: Partial<PumpInput> = {}): PumpInput => ({ eligible: true, exclusionReasons: [], classification: "advance_candidate", heuristicScore: 62, riskFlags: [], features: early, ...over });

describe("strategy pump chance (heuristic level, not a probability)", () => {
  it("grades advance setups by score and explains every early-surge condition", () => {
    const high = pumpChance(pin(), p);
    expect(high.chance).toBe("high");
    expect(high.setupChecks).toBe(4);
    expect(high.reasons[0]).toMatch(/early-surge setup/);
    expect(high.reasons.join(" ")).toMatch(/volume building \+40\.0% in 2h/);
    expect(pumpChance(pin({ heuristicScore: HIGH_PUMP_SCORE - 1 }), p).chance).toBe("medium");
  });

  it("treats moves underway as late, and gradual, market-wide or overextended moves as low", () => {
    expect(pumpChance(pin({ classification: "move_underway", heuristicScore: 70 }), p).chance).toBe("medium");
    expect(pumpChance(pin({ classification: "move_underway", heuristicScore: 40 }), p).chance).toBe("low");
    for (const c of ["gradual_trend", "market_wide", "overextended"] as const) expect(pumpChance(pin({ classification: c }), p).chance).toBe("low");
  });

  it("marks a forming setup (3 of 4 conditions, decent score) as medium and lists what is missing", () => {
    const forming = pumpChance(pin({ classification: "none", heuristicScore: 45, features: { ...early, vol24_change_2h: 0.05 } }), p);
    expect(forming).toMatchObject({ chance: "medium", setupChecks: 3 });
    expect(forming.reasons.join(" | ")).toMatch(/✗ volume not building/);
    expect(pumpChance(pin({ classification: "none", heuristicScore: 20, features: { ...early, vol24_change_2h: 0.05 } }), p).chance).toBe("low");
    expect(pumpChance(pin({ classification: "none", features: { ...early, vol24_change_2h: 0.05, accel_1h: -0.01 } }), p).chance).toBe("low");
  });

  it("is low for ineligible coins and for manipulation-like volume, and notes cautions", () => {
    const ineligible = pumpChance(pin({ eligible: false, exclusionReasons: ["warming_up", "excluded_class:stablecoin"] }), p);
    expect(ineligible).toMatchObject({ chance: "low" });
    expect(ineligible.reasons[0]).toMatch(/not eligible: warming up .*stablecoin/);
    expect(pumpChance(pin({ riskFlags: ["possible_wash_trading"] }), p).chance).toBe("low");
    expect(pumpChance(pin({ riskFlags: ["micro_cap", "thin_history"] }), p).reasons.at(-1)).toMatch(/caution: micro cap, short history/);
  });

  it("orders recommendations by chance, then score", () => {
    const rows = [
      { assetId: "b", pumpChance: "medium" as const, heuristicScore: 90 },
      { assetId: "a", pumpChance: "high" as const, heuristicScore: 51 },
      { assetId: "c", pumpChance: "high" as const, heuristicScore: 70 },
    ];
    expect([...rows].sort(byPumpChance).map((r) => r.assetId)).toEqual(["c", "a", "b"]);
  });
});

describe("combined recommendation (strategy + agents + guardrails)", () => {
  it("says buy only when the strategy, a candidate status and the agents agree", () => {
    expect(combineRecommendation({ pumpChance: "high", status: "candidate", agentRecommendation: "buy", reviewOutcome: "agree" }).recommendation).toBe("buy");
    expect(combineRecommendation({ pumpChance: "high", status: "watch", agentRecommendation: "buy", reviewOutcome: "agree" })).toMatchObject({ recommendation: "watch", reason: expect.stringMatching(/cap the setup at watch/) });
    expect(combineRecommendation({ pumpChance: "medium", status: "candidate", agentRecommendation: "hold", reviewOutcome: "agree" }).recommendation).toBe("watch");
    expect(combineRecommendation({ pumpChance: "high", status: "candidate", agentRecommendation: null, reviewOutcome: null }).recommendation).toBe("watch");
  });

  it("says avoid on any agent sell, review rejection, low chance or missing data", () => {
    expect(combineRecommendation({ pumpChance: "high", status: "candidate", agentRecommendation: "sell", reviewOutcome: "agree" }).recommendation).toBe("avoid");
    expect(combineRecommendation({ pumpChance: "high", status: "no_signal", agentRecommendation: "buy", reviewOutcome: "reject" }).recommendation).toBe("avoid");
    expect(combineRecommendation({ pumpChance: "low", status: "candidate", agentRecommendation: "buy", reviewOutcome: "agree" }).recommendation).toBe("avoid");
    expect(combineRecommendation({ pumpChance: "high", status: "insufficient_data", agentRecommendation: "hold", reviewOutcome: "agree" }).recommendation).toBe("avoid");
  });
});

describe("three-day and VMC context", () => {
  const slot = new Date("2026-11-03T12:00:00Z");
  const at = (h: number, price: number | null) => ({ slotTime: new Date(slot.getTime() - h * 3_600_000), price });

  it("measures the stored 72h move, high and low without filling gaps", () => {
    const t = threeDayStats([at(72, 1), at(40, 1.5), at(20, null), at(1, 0.9), at(0, 1.2), at(80, 9)], slot);
    expect(t).toMatchObject({ high: 1.5, low: 0.9, fromPrice: 1, spanHours: 72, points: 4 });
    expect(t.change).toBeCloseTo(0.2, 10);
    const partial = threeDayStats([at(30, 2), at(0, 1)], slot);
    expect(partial).toMatchObject({ change: -0.5, spanHours: 30 });
    expect(threeDayStats([at(5, 1)], slot).change).toBeNull(); // no current hour
  });

  it("compares the current volume/market cap ratio with the six-month baseline", () => {
    expect(vmcContext(0.06, { meanRatio: 0.02, status: "full", validDays: 184, windowStart: "2026-05-03", windowEnd: "2026-11-02" })).toMatchObject({ multiple: 3, baselineStatus: "full", baselineWindow: "2026-05-03..2026-11-02" });
    expect(vmcContext(0.06, null)).toMatchObject({ multiple: null, baselineMean: null });
    expect(vmcContext(0.06, { meanRatio: 0, status: "partial", validDays: 3, windowStart: "a", windowEnd: "b" }).multiple).toBeNull();
  });
});

describe("agent stance and guardrails", () => {
  const assessment = (over: Partial<AssetAssessment> = {}): AssetAssessment => {
    const pk = makePack();
    return {
      assetId: ASSET_ID, status: "candidate", signalType: "advance", horizonHours: 24, score: 60,
      evidence: [{ metric: "vol24_change_2h", value: 0.6, observedAt: OBSERVED, interpretation: "rolling volume up" }],
      counterevidence: [], dataQuality: { assessment: "good", issues: [], missing: [] },
      entryTrigger: pk.scenario.entryRule, invalidation: pk.scenario.stopRule,
      exitConditions: { target: pk.scenario.targetRule, trailing: pk.scenario.trailingRule, maxHoldingHours: 24 },
      expiresAt: pk.scenario.signalExpiresAt, rationale: "test", recommendation: "buy", recommendationReason: "clean setup", ...over,
    };
  };
  const agree: Review = { assetId: ASSET_ID, verdict: "agree", recommendedStatus: "candidate", confidence: "high", concerns: [], failureConditions: ["below stop"], dataQualityIssues: [] };

  it("requires a stance from internal agents but not from external MCP reports", () => {
    expect(AssessmentSchema.safeParse(assessment()).success).toBe(true);
    const { recommendation: _r, recommendationReason: _rr, ...noStance } = assessment();
    expect(AssessmentSchema.safeParse(noStance).success).toBe(false);
    expect(ExternalAssessment.safeParse(noStance).success).toBe(true);
    expect(AssessmentSchema.safeParse(assessment({ recommendation: "strong_buy" as never })).success).toBe(false);
  });

  it("keeps the agents' own stance and combines it with the strategy", () => {
    const pack = makePack({ historyDepth: 30 });
    const f = finalizeSignal(pack, { analyst: assessment(), coordinator: assessment(), review: agree }, { candidateMinHistory: 25 });
    expect(f).toMatchObject({ status: "candidate", pumpChance: "high", agentRecommendation: "buy", recommendation: "buy" });
    const rejected = finalizeSignal(pack, { analyst: assessment(), coordinator: assessment(), review: { ...agree, verdict: "reject", recommendedStatus: "no_signal" } }, { candidateMinHistory: 25 });
    expect(rejected).toMatchObject({ status: "no_signal", agentRecommendation: "buy", recommendation: "avoid" });
  });

  it("caps candidate at watch unless the base strategy saw an advance pattern", () => {
    const pack = makePack({ historyDepth: 30, screening: { classification: "none", heuristicScore: 55, components: {}, riskFlags: [], rank: 1 }, pump: { chance: "medium", reasons: ["setup forming"] } });
    const f = finalizeSignal(pack, { analyst: assessment(), coordinator: assessment(), review: agree }, { candidateMinHistory: 25 });
    expect(f.status).toBe("watch");
    expect(f.dataQuality.guardrailNotes.join(" ")).toMatch(/not an advance setup/);
    expect(f.recommendation).toBe("watch");
  });

  it("verifies evidence that cites the 3-day and VMC context like any other value", () => {
    const pack = makePack();
    const items = [
      { metric: "context.threeDay.change", value: 0.12, observedAt: OBSERVED, interpretation: "up 12% over three days" },
      { metric: "context.vmc.multiple", value: 9.9, observedAt: OBSERVED, interpretation: "wrong value" },
      { metric: "context.nope", value: 1, observedAt: OBSERVED, interpretation: "unknown path" },
    ];
    const { kept, notes } = verifyEvidence(pack, items);
    expect(kept.map((k) => k.metric)).toEqual(["context.threeDay.change"]);
    expect(notes).toHaveLength(2);
  });

  it("never recommends buy without agent review", () => {
    expect(deterministicSignal(makePack(), "agents off")).toMatchObject({ agentRecommendation: null, recommendation: "watch" });
    expect(deterministicSignal(makePack({ pump: { chance: "low", reasons: [] } }), "agents off").recommendation).toBe("avoid");
  });
});

describe("Telegram pump watchlist table", () => {
  const row = (i: number, over: Partial<RecommendationRow> = {}): RecommendationRow => ({
    symbol: i === 0 ? "VERYLONGSYM" : `C${i}`, name: `Coin <${i}>`, price: 0.000684, marketCap: 61.4e6, volume24h: 9.6e6,
    threeDayChange: -0.124, threeDaySpanHours: 72, vmcCurrent: 0.157, vmcBaseline: 0.023, vmcMultiple: 6.83,
    pumpChance: "high", pumpReasons: ["early-surge setup: all conditions met (score 60)", "✓ volume building +50.6% in 2h (≥ +15%)"],
    agentRecommendation: "buy", agentReason: "Clean build-up with volume far above its six-month norm.", agentOrigin: "agent",
    recommendation: "buy", recommendationReason: "strategy and agents agree", risk: ["thin_history"],
    scenario: { entryPrice: 0.000691, stopPrice: 0.000643, targetPrice: 0.000795, expiresAt: "2026-11-03T18:00:00.000Z" }, ...over,
  });
  const input = (recommendations: RecommendationRow[]): ReportInput => ({
    generatedAt: new Date("2026-11-03T12:10:00Z"), slotTime: new Date("2026-11-03T12:00:00Z"), timezone: "Asia/Tehran", providerName: "CMC", isLive: true, attribution: null,
    coverage: { label: "complete", collected: 8041, universeSize: 8041, coveragePct: 100, stale: 0 }, oldestObservedAt: null, agentStatus: "completed", summary: null, screened: 1016, eligible: 779, rows: [], recommendations,
  });

  it("renders a phone-width monospace table with every requested column", () => {
    const t = recTable([row(0), row(1, { pumpChance: "medium", agentRecommendation: null, recommendation: "watch", vmcMultiple: null, threeDayChange: null })]);
    const pre = /<pre>([\s\S]*)<\/pre>/.exec(t)![1]!.replace(/&lt;|&gt;|&amp;/g, "x").split("\n");
    expect(pre[0]).toMatch(/^Coin\s+3d\s+MCap\s+VMC\s+Pump\s+Agent\s+Rec$/);
    expect(pre[1]).toMatch(/^VERYLO\s+-12\.4%\s+61M\s+6\.8x\s+HIGH\s+BUY\s+BUY$/);
    expect(pre[2]).toMatch(/^C1\s+n\/a\s+61M\s+n\/a\s+MED\s+-\s+WATCH$/);
    for (const line of pre) expect(line.length).toBeLessThanOrEqual(44);
    expect(t).toMatch(/not a probability/);
  });

  it("follows the table with cards only for buy/high-pump coins, in one short message", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, i < 5 ? {} : { pumpChance: "medium", recommendation: "watch", agentRecommendation: null }));
    const parts = formatReport({ ...input(rows), summary: "First sentence here. A second very long sentence that should be dropped." });
    const text = parts.join("\n");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("<pre>");
    expect(text.match(/<b>\d+\. /g)).toHaveLength(3);
    expect(text).toMatch(/✅ BUY \(paper, on entry trigger\) · 🔥 HIGH · agents BUY/);
    expect(text).toMatch(/VMC 6\.8x/);
    expect(text).toMatch(/\+7 more in the table above/);
    expect(text).toContain("First sentence here.");
    expect(text).not.toContain("second very long");
    for (const m of parts) expect(m.length).toBeLessThanOrEqual(2500);
  });
});

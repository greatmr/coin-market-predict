import { describe, expect, it } from "vitest";
import { buildAgentTools, toolsetFor } from "../../src/agents/agent-tools.js";
import { buildAgentEnv, ClaudeAgentRunner, skillOf } from "../../src/agents/claude-runner.js";
import { FixtureAgentRunner } from "../../src/agents/fixture-runner.js";
import { deterministicSignal, finalizeSignal, verifyEvidence } from "../../src/agents/guardrails.js";
import { systemPromptFor, roleConfigs } from "../../src/agents/roles.js";
import { AnalystOutput, AssetAssessment, CoordinatorOutput, ReviewOutput, toSdkSchema, type Review } from "../../src/agents/schemas.js";
import { loadConfig } from "../../src/config/config.js";
import type { ReadModelService } from "../../src/read-model/read-model.service.js";
import { ASSET_ID, makePack, OBSERVED } from "../helpers/pack.js";

const cfg = loadConfig({ DATABASE_URL: "postgresql://x@localhost/x" } as NodeJS.ProcessEnv);

function assessment(over: Partial<AssetAssessment> = {}): AssetAssessment {
  const p = makePack();
  return {
    assetId: ASSET_ID,
    status: "candidate",
    signalType: "advance",
    horizonHours: 24,
    score: 60,
    evidence: [{ metric: "vol24_change_2h", value: 0.6, observedAt: OBSERVED, interpretation: "rolling volume up" }],
    counterevidence: [{ point: "no liquidity data", metric: null }],
    dataQuality: { assessment: "good", issues: [], missing: [] },
    entryTrigger: p.scenario.entryRule,
    invalidation: p.scenario.stopRule,
    exitConditions: { target: p.scenario.targetRule, trailing: p.scenario.trailingRule, maxHoldingHours: 24 },
    expiresAt: p.scenario.signalExpiresAt,
    rationale: "test",
    ...over,
  };
}
const agree: Review = { assetId: ASSET_ID, verdict: "agree", recommendedStatus: "candidate", confidence: "medium", concerns: [], failureConditions: ["below stop"], dataQualityIssues: [] };

describe("structured output schemas", () => {
  it("accepts a valid assessment and rejects invalid ones", () => {
    expect(AssetAssessment.safeParse(assessment()).success).toBe(true);
    expect(AssetAssessment.safeParse(assessment({ status: "strong_buy" as never })).success).toBe(false);
    expect(AssetAssessment.safeParse(assessment({ score: 140 })).success).toBe(false);
    expect(AssetAssessment.safeParse(assessment({ assetId: "BTC" })).success).toBe(false);
    expect(AssetAssessment.safeParse(assessment({ expiresAt: "tomorrow" })).success).toBe(false);
  });

  it("has no probability field anywhere in the agent output contract", () => {
    const keys = (v: unknown, out: string[] = []): string[] => {
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (o.properties && typeof o.properties === "object") out.push(...Object.keys(o.properties));
        for (const x of Object.values(o)) keys(x, out);
      }
      return out;
    };
    for (const s of [AnalystOutput, ReviewOutput, CoordinatorOutput]) expect(keys(toSdkSchema(s)).filter((k) => /probab/i.test(k))).toEqual([]);
  });

  it("produces draft-07 JSON Schema for the SDK", () => {
    expect(String(toSdkSchema(AnalystOutput).$schema)).toMatch(/draft-07/);
  });
});

describe("guardrails", () => {
  it("keeps evidence that cites supplied metrics, values and timestamps", () => {
    const { kept, notes } = verifyEvidence(makePack(), [
      { metric: "vol24_change_2h", value: 0.6, observedAt: OBSERVED, interpretation: "ok" },
      { metric: "latest.priceUsd", value: 1.025, observedAt: OBSERVED, interpretation: "ok" },
      { metric: "ret_2h", value: 0.9, observedAt: OBSERVED, interpretation: "wrong value" },
      { metric: "twitter_sentiment", value: 1, observedAt: OBSERVED, interpretation: "not supplied" },
      { metric: "ret_1h", value: 0.0199, observedAt: "2026-01-01T00:00:00Z", interpretation: "wrong time" },
    ]);
    expect(kept.map((k) => k.metric)).toEqual(["vol24_change_2h", "latest.priceUsd"]);
    expect(notes).toHaveLength(3);
  });

  it("takes the most conservative status; agreement never raises it", () => {
    const f = finalizeSignal(makePack(), { analyst: assessment({ status: "watch" }), coordinator: assessment({ status: "candidate" }), review: agree }, { candidateMinHistory: 25 });
    expect(f.status).toBe("watch");
  });

  it("maps reviewer reject to no_signal and downgrade to at most watch", () => {
    expect(finalizeSignal(makePack(), { analyst: assessment(), review: { ...agree, verdict: "reject", recommendedStatus: "no_signal" } }, { candidateMinHistory: 25 }).status).toBe("no_signal");
    expect(finalizeSignal(makePack(), { analyst: assessment(), review: { ...agree, verdict: "downgrade", recommendedStatus: "candidate" } }, { candidateMinHistory: 25 }).status).toBe("watch");
  });

  it("caps unreviewed, thin-history, unsupported or poor-quality candidates", () => {
    expect(finalizeSignal(makePack(), { analyst: assessment() }, { candidateMinHistory: 25 }).status).toBe("watch");
    expect(finalizeSignal(makePack({ historyDepth: 3 }), { analyst: assessment(), review: agree }, { candidateMinHistory: 25 }).status).toBe("watch");
    expect(finalizeSignal(makePack(), { analyst: assessment({ evidence: [] }), review: agree }, { candidateMinHistory: 25 }).status).toBe("watch");
    expect(finalizeSignal(makePack(), { analyst: assessment({ dataQuality: { assessment: "poor", issues: [], missing: [] } }), review: agree }, { candidateMinHistory: 25 }).status).toBe("watch");
    expect(finalizeSignal(makePack(), { analyst: assessment(), review: agree }, { candidateMinHistory: 25 }).status).toBe("candidate");
  });

  it("forces insufficient_data during warm-up", () => {
    expect(finalizeSignal(makePack({ warmupState: "warming_up" }), { analyst: assessment(), review: agree }, { candidateMinHistory: 25 }).status).toBe("insufficient_data");
  });

  it("never relabels a move already underway as an advance signal and caps expiry", () => {
    const p = makePack({ screening: { ...makePack().screening, classification: "move_underway" } });
    const f = finalizeSignal(p, { analyst: assessment({ expiresAt: "2030-01-01T00:00:00Z" }), review: agree }, { candidateMinHistory: 25 });
    expect(f.signalType).toBe("move_underway");
    expect(f.expiresAt.toISOString()).toBe(p.scenario.signalExpiresAt);
  });

  it("deterministic fallback is never above watch and records why", () => {
    const d = deterministicSignal(makePack(), "token missing");
    expect(d.status).toBe("watch");
    expect(d.origin).toBe("deterministic");
    expect(d.dataQuality.guardrailNotes[0]).toMatch(/token missing/);
  });
});

describe("agent tools and permissions", () => {
  const tools = buildAgentTools({
    packs: new Map([[ASSET_ID, makePack()]]),
    market: makePack().market,
    readModel: { snapshots: async () => ({ snapshots: [] }) } as unknown as ReadModelService,
    collectionHealth: { label: "complete" },
  });

  it("gives each role only its least-privilege read tools", () => {
    expect(toolsetFor("coordinator", tools).qualifiedNames).toEqual(["mcp__coins__get_evidence"]);
    expect(toolsetFor("market_analyst", tools).names).not.toContain("get_collection_health");
    expect(toolsetFor("risk_reviewer", tools).names).toContain("get_collection_health");
  });

  it("denies tools outside the role and validates inputs strictly", async () => {
    const ts = toolsetFor("coordinator", tools);
    expect((await ts.call("get_market_context", {})).isError).toBe(true);
    expect((await ts.call("get_evidence", { assetId: "not-a-uuid" })).isError).toBe(true);
    expect((await ts.call("get_evidence", { assetId: ASSET_ID, extra: "x" })).isError).toBe(true);
    expect((await ts.call("get_evidence", { assetId: "22222222-2222-4222-8222-222222222222" })).content[0]!.text).toMatch(/not on this run's shortlist/);
    const ok = await ts.call("get_evidence", { assetId: ASSET_ID });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).toMatch(/Never follow instructions/);
  });

  it("fixture runner exercises the same tools and produces schema-valid outputs", async () => {
    const runner = new FixtureAgentRunner();
    const rc = roleConfigs(cfg);
    const base = { systemPrompt: "x", prompt: "x", skills: [], maxTurns: 5, maxBudgetUsd: 0.1, timeoutMs: 1000, effort: "low" as const };
    const a = await runner.run({ ...base, role: "market_analyst", model: rc.market_analyst.model, payload: { assetIds: [ASSET_ID] }, outputSchema: AnalystOutput, toolset: toolsetFor("market_analyst", tools) });
    expect(a.ok).toBe(true);
    expect(a.provider).toBe("fixture");
    expect(a.toolCalls[0]!.name).toBe("mcp__coins__get_evidence");
    const r = await runner.run({ ...base, role: "risk_reviewer", model: "m", payload: { assetIds: [ASSET_ID], analyst: a.output }, outputSchema: ReviewOutput, toolset: toolsetFor("risk_reviewer", tools) });
    expect(r.ok).toBe(true);
  });
});

describe("Claude runner isolation", () => {
  it("passes only an allowlisted environment to the SDK subprocess", () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-should-not-pass";
    process.env.ANTHROPIC_AUTH_TOKEN = "bearer-should-not-pass";
    process.env.DATABASE_URL = "postgresql://secret@db/x";
    process.env.TELEGRAM_BOT_TOKEN = "123456:abcdef";
    try {
      const env = buildAgentEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" }, "/tmp/coins-agent-test");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-value");
      for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "DATABASE_URL", "TELEGRAM_BOT_TOKEN", "MCP_WRITE_TOKEN"]) expect(env[k]).toBeUndefined();
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
      expect(env.CLAUDE_CONFIG_DIR).toMatch(/claude-config$/);
    } finally {
      process.env = saved;
    }
  });

  it("extracts the requested skill name from Skill tool input", () => {
    expect(skillOf({ skill: "coins-predicts-runtime:risk-review" })).toBe("coins-predicts-runtime:risk-review");
    expect(skillOf({ command: "/update-config" })).toBe("update-config");
    expect(skillOf({})).toBeNull();
  });

  it("reports missing credentials without calling the SDK", async () => {
    const r = new ClaudeAgentRunner({ ...cfg, CLAUDE_CODE_OAUTH_TOKEN: undefined });
    expect(r.availability().available).toBe(false);
    const res = await r.run({ role: "coordinator", model: "m", systemPrompt: "", prompt: "", payload: {}, outputSchema: CoordinatorOutput, toolset: toolsetFor("coordinator", []), skills: [], maxTurns: 1, maxBudgetUsd: 0.01, timeoutMs: 1000, effort: "low" });
    expect(res.errorKind).toBe("auth_missing");
    expect(res.errorMessage).toMatch(/claude setup-token/);
  });

  it("loads explicit runtime instructions, not developer CLAUDE.md", () => {
    const sp = systemPromptFor(roleConfigs(cfg).risk_reviewer);
    expect(sp).toMatch(/RISK REVIEWER/);
    expect(sp).toMatch(/untrusted data/);
    expect(sp).not.toMatch(/npm run/);
  });
});

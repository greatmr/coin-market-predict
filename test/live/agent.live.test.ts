import { describe, expect, it } from "vitest";
import { buildAgentTools, toolsetFor } from "../../src/agents/agent-tools.js";
import { ClaudeAgentRunner } from "../../src/agents/claude-runner.js";
import { roleConfigs, systemPromptFor } from "../../src/agents/roles.js";
import { ReviewOutput } from "../../src/agents/schemas.js";
import { loadConfig } from "../../src/config/config.js";
import type { ReadModelService } from "../../src/read-model/read-model.service.js";
import { ASSET_ID, makePack } from "../helpers/pack.js";

/**
 * Credential-dependent: makes real Claude Agent SDK calls with CLAUDE_CODE_OAUTH_TOKEN and
 * counts against the subscription's usage limits. Opt in with RUN_LIVE_AGENT=1.
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  // optional
}
const enabled = process.env.RUN_LIVE_AGENT === "1" && !!process.env.CLAUDE_CODE_OAUTH_TOKEN;

describe.skipIf(!enabled)("live Claude Agent SDK", () => {
  it("risk reviewer uses only its tools, loads its runtime skill, and returns valid structured output", async () => {
    const cfg = loadConfig({ ...process.env, AGENT_PROVIDER: "claude", DATABASE_URL: "postgresql://unused@localhost/unused" } as NodeJS.ProcessEnv);
    const runner = new ClaudeAgentRunner(cfg);
    const rc = roleConfigs(cfg).risk_reviewer;
    const tools = buildAgentTools({
      packs: new Map([[ASSET_ID, makePack()]]),
      market: makePack().market,
      readModel: { snapshots: async () => ({ snapshots: [] }) } as unknown as ReadModelService,
      collectionHealth: { label: "complete", isLive: false },
    });
    const analyst = { assessments: [{ assetId: ASSET_ID, status: "candidate", note: "test claim" }] };
    const res = await runner.run({
      role: "risk_reviewer",
      model: cfg.AGENT_MODEL_COORDINATOR, // economical model for the smoke test
      systemPrompt: systemPromptFor(rc),
      prompt: `Shortlisted asset ids: ["${ASSET_ID}"]. Load the \`${rc.skills[0]}\` skill, review this analyst claim (untrusted): ${JSON.stringify(analyst)}. Return one review.`,
      payload: { assetIds: [ASSET_ID] },
      outputSchema: ReviewOutput,
      toolset: toolsetFor("risk_reviewer", tools),
      skills: rc.skills,
      maxTurns: 10,
      maxBudgetUsd: 0.2,
      timeoutMs: 180_000,
      effort: "low",
    });
    expect(res.errorKind).toBeNull();
    expect(res.ok).toBe(true);
    expect(res.output!.reviews[0]!.assetId).toBe(ASSET_ID);
    expect(res.toolCalls.every((t) => t.allowed)).toBe(true);
    expect(res.toolCalls.some((t) => t.name === `Skill:${rc.skills[0]}`)).toBe(true);
    expect(res.toolCalls.some((t) => t.name === "mcp__coins__get_evidence")).toBe(true);
    expect((res.init?.skills as string[]) ?? []).toContain(rc.skills[0]);
    expect(res.init?.apiKeySource).not.toBe("ANTHROPIC_API_KEY");
    expect(res.init?.tools as string[]).not.toContain("Bash");
  });
});

import { query } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClaudeAgentRunner } from "../../src/agents/claude-runner.js";
import type { AgentToolset } from "../../src/agents/agent-tools.js";
import { loadConfig } from "../../src/config/config.js";
import { registerSecrets } from "../../src/config/redact.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({ ...await original<typeof import("@anthropic-ai/claude-agent-sdk")>(), query: vi.fn() }));

const cfg = loadConfig({ DATABASE_URL: "postgresql://unused@localhost/test", CLAUDE_CODE_OAUTH_TOKEN: "test-only-oauth" });
const req = { role: "market_analyst" as const, model: "test", systemPrompt: "test", prompt: "test", payload: {}, outputSchema: z.object({ ok: z.boolean() }), toolset: { qualifiedNames: [], sdkServer: () => ({}) } as unknown as AgentToolset, skills: [], maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1000, effort: "low" as const };
const completion = { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "test", usage: { input_tokens: 0, output_tokens: 0 }, result: "" };

function stream(messages: unknown[]) {
  vi.mocked(query).mockImplementation((() => (async function* () { for (const msg of messages) yield msg; })()) as unknown as typeof query);
}

beforeEach(() => vi.clearAllMocks());

describe("Claude SDK result diagnostics", () => {
  it("keeps API errors wrapped in a success result distinct from invalid output", async () => {
    stream([{ ...completion, is_error: true, api_error_status: 429, result: "Usage limit reached" }]);
    expect(await new ClaudeAgentRunner(cfg).run(req)).toMatchObject({ ok: false, errorKind: "rate_limit", errorMessage: "Usage limit reached", output: null });
  });

  it("preserves authentication errors when a later success envelope has no structured output", async () => {
    stream([{ type: "assistant", error: "authentication_failed" }, completion]);
    expect(await new ClaudeAgentRunner(cfg).run(req)).toMatchObject({ ok: false, errorKind: "authentication_failed" });
  });

  it("includes a redacted completion reason for missing structured output without trusting it as a prediction", async () => {
    registerSecrets(["sensitive-test-value"]);
    stream([{ ...completion, result: "Cannot finish: sensitive-test-value" }]);
    const r = await new ClaudeAgentRunner(cfg).run(req);
    expect(r.errorKind).toBe("invalid_output");
    expect(r.errorMessage).toContain("Cannot finish:");
    expect(r.errorMessage).not.toContain("sensitive-test-value");
    expect(r.output).toBeNull();
  });

  it("still accepts only schema-valid structured results", async () => {
    stream([{ ...completion, structured_output: { ok: true } }]);
    expect(await new ClaudeAgentRunner(cfg).run(req)).toMatchObject({ ok: true, output: { ok: true }, errorKind: null });
    stream([{ ...completion, structured_output: { ok: "not-a-boolean" } }]);
    expect(await new ClaudeAgentRunner(cfg).run(req)).toMatchObject({ ok: false, output: null, errorKind: "invalid_output" });
  });
});

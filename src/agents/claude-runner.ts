import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { query, type HookInput, type HookJSONOutput, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Logger } from "@nestjs/common";
import type { AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { AGENT_MCP_SERVER } from "./agent-tools.js";
import { emptyUsage, type AgentErrorKind, type AgentRequest, type AgentResult, type AgentRunner } from "./runner.js";
import { toSdkSchema } from "./schemas.js";

/** Paths of runtime assets shipped with the app (also copied into the container image). */
export const RUNTIME_DIR = resolve(process.env.COINS_RUNTIME_DIR ?? "runtime");
export const RUNTIME_PLUGIN_DIR = resolve(RUNTIME_DIR, "plugin");
export const RUNTIME_PLUGIN_NAME = "coins-predicts-runtime";

/**
 * Build the subprocess environment from an allowlist. The application's environment
 * (DATABASE_URL, Telegram token, MCP tokens, ANTHROPIC_API_KEY, ...) is never forwarded.
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are deliberately absent so the SDK cannot silently
 * fall back to paid API-key authentication.
 */
export function buildAgentEnv(cfg: Pick<AppConfig, "CLAUDE_CODE_OAUTH_TOKEN">, stateDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: resolve(stateDir, "home"),
    CLAUDE_CONFIG_DIR: resolve(stateDir, "claude-config"),
    TMPDIR: resolve(stateDir, "tmp"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "coins-predicts/0.1.0",
  };
  for (const k of ["LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "NO_PROXY"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (cfg.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = cfg.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

const ERROR_MAP: Record<string, AgentErrorKind> = {
  authentication_failed: "authentication_failed",
  oauth_org_not_allowed: "authentication_failed",
  account_on_hold: "authentication_failed",
  verification_required: "authentication_failed",
  billing_error: "billing_error",
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  model_not_found: "model_not_found",
};

export class ClaudeAgentRunner implements AgentRunner {
  readonly provider = "claude_agent_sdk" as const;
  private readonly log = new Logger("ClaudeAgentRunner");
  private readonly stateDir: string;
  private readonly workspace: string;

  constructor(private readonly cfg: AppConfig) {
    this.stateDir = resolve(process.env.COINS_STATE_DIR ?? "var/agent");
    this.workspace = resolve(this.stateDir, "workspace");
    for (const d of ["home", "claude-config", "tmp", "workspace"]) mkdirSync(resolve(this.stateDir, d), { recursive: true, mode: 0o700 });
  }

  availability() {
    if (!this.cfg.CLAUDE_CODE_OAUTH_TOKEN) {
      return { available: false, reason: "CLAUDE_CODE_OAUTH_TOKEN is not set (generate one with `claude setup-token`)" };
    }
    return { available: true, reason: null };
  }

  async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    const started = Date.now();
    const base: AgentResult<T> = {
      ok: false,
      output: null,
      errorKind: null,
      errorMessage: null,
      usage: emptyUsage(),
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      sessionId: null,
      toolCalls: [],
      provider: this.provider,
    };
    const avail = this.availability();
    if (!avail.available) return { ...base, errorKind: "auth_missing", errorMessage: avail.reason };

    const allowed = new Set(req.toolset.qualifiedNames);
    const toolCalls: AgentResult<T>["toolCalls"] = [];
    // Defense in depth: deny any tool outside this role's allowlist, and record every call.
    // The SDK also lists Claude Code's bundled skills; only the role's runtime skills may load.
    const guard = async (input: HookInput): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const name = input.tool_name;
      const skillName = name === "Skill" ? skillOf(input.tool_input) : null;
      const ok = allowed.has(name) || name === "StructuredOutput" || (name === "Skill" && skillName !== null && req.skills.includes(skillName));
      if (name !== "StructuredOutput") toolCalls.push({ name: skillName ? `Skill:${skillName}` : name, allowed: ok });
      if (ok) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Tool ${name} is not permitted for role ${req.role}`,
        },
      };
    };

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), req.timeoutMs);
    let result: AgentResult<T> = base;
    let sawResult = false;
    try {
      const q = query({
        prompt: req.prompt,
        options: {
          model: req.model,
          systemPrompt: req.systemPrompt,
          // No built-in tools (no shell, file, or web access). Skill loads runtime skills only.
          tools: ["Skill"],
          allowedTools: [...req.toolset.qualifiedNames],
          permissionMode: "dontAsk",
          // Do not load developer CLAUDE.md, rules, settings, or user skills.
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: { [AGENT_MCP_SERVER]: req.toolset.sdkServer() },
          plugins: [{ type: "local", path: RUNTIME_PLUGIN_DIR }],
          skills: req.skills,
          outputFormat: { type: "json_schema", schema: toSdkSchema(req.outputSchema) },
          maxTurns: req.maxTurns,
          maxBudgetUsd: req.maxBudgetUsd,
          effort: req.effort,
          cwd: this.workspace,
          env: buildAgentEnv(this.cfg, this.stateDir),
          persistSession: false,
          abortController: abort,
          hooks: { PreToolUse: [{ hooks: [guard] }] },
          stderr: (d: string) => this.log.debug(redact(d).slice(0, 500)),
        },
      });
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        result = this.consume(msg, result, req);
        if (msg.type === "result") sawResult = true;
      }
    } catch (err) {
      if (abort.signal.aborted) result = { ...result, errorKind: "timeout", errorMessage: `timed out after ${req.timeoutMs} ms` };
      else if (!sawResult || !result.errorKind) result = { ...result, errorKind: result.errorKind ?? "sdk_error", errorMessage: redact(err) };
    } finally {
      clearTimeout(timer);
    }
    return { ...result, toolCalls, durationMs: Date.now() - started };
  }

  private consume<T>(msg: SDKMessage, acc: AgentResult<T>, req: AgentRequest<T>): AgentResult<T> {
    if (msg.type === "system" && msg.subtype === "init") {
      const init = {
        model: msg.model,
        tools: msg.tools,
        skills: msg.skills,
        plugins: msg.plugins,
        mcpServers: msg.mcp_servers,
        apiKeySource: msg.apiKeySource,
        permissionMode: msg.permissionMode,
      };
      const missing = req.skills.filter((s) => !msg.skills.includes(s));
      if (missing.length) this.log.warn(`runtime skills not loaded for ${req.role}: ${missing.join(", ")}`);
      if (msg.apiKeySource === "ANTHROPIC_API_KEY") this.log.error("unexpected API-key authentication source; aborting");
      return { ...acc, sessionId: msg.session_id, init };
    }
    if (msg.type === "assistant" && msg.error) {
      const kind = ERROR_MAP[msg.error] ?? "sdk_error";
      return { ...acc, errorKind: kind, errorMessage: describeError(kind) };
    }
    if (msg.type === "result") {
      const usage = {
        inputTokens: msg.usage.input_tokens ?? 0,
        outputTokens: msg.usage.output_tokens ?? 0,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      };
      const common = { ...acc, usage, costUsd: msg.total_cost_usd, numTurns: msg.num_turns, sessionId: msg.session_id };
      if (msg.subtype === "success") {
        if (msg.is_error) {
          const status = msg.api_error_status;
          const kind: AgentErrorKind = status === 401 || status === 403 ? "authentication_failed" : status === 402 ? "billing_error" : status === 429 ? "rate_limit" : status === 404 ? "model_not_found" : status === 529 ? "overloaded" : acc.errorKind ?? "sdk_error";
          return { ...common, errorKind: kind, errorMessage: redact(msg.result || describeError(kind)).slice(0, 500) };
        }
        if (msg.structured_output === undefined || msg.structured_output === null) {
          const detail = msg.result ? `: ${redact(msg.result).slice(0, 400)}` : "";
          return { ...common, errorKind: acc.errorKind ?? "invalid_output", errorMessage: acc.errorMessage ?? `run completed without structured output${detail}` };
        }
        const parsed = req.outputSchema.safeParse(msg.structured_output);
        if (!parsed.success) {
          return { ...common, errorKind: "invalid_output", errorMessage: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
        }
        return { ...common, ok: true, output: parsed.data, errorKind: null, errorMessage: null };
      }
      const kind: AgentErrorKind =
        acc.errorKind ??
        (msg.subtype === "error_max_budget_usd"
          ? "budget_exceeded"
          : msg.subtype === "error_max_turns"
            ? "max_turns"
            : msg.subtype === "error_max_structured_output_retries"
              ? "invalid_output"
              : "sdk_error");
      return { ...common, errorKind: kind, errorMessage: acc.errorMessage ?? redact(msg.errors.join("; ")).slice(0, 500) };
    }
    return acc;
  }
}

/** Skill name from a Skill tool call input (the field name has varied across versions). */
export function skillOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const v = o.skill ?? o.name ?? o.command;
  return typeof v === "string" ? v.replace(/^\//, "") : null;
}

export function describeError(kind: AgentErrorKind): string {
  switch (kind) {
    case "authentication_failed":
      return "Claude authentication failed: CLAUDE_CODE_OAUTH_TOKEN is invalid, expired, or not permitted. Regenerate it with `claude setup-token` (tokens last about one year and are not refreshed automatically).";
    case "rate_limit":
      return "Claude usage limit reached (HTTP 429). Agent analysis is deferred; deterministic screening still runs.";
    case "billing_error":
      return "Claude subscription/billing problem for this token.";
    case "overloaded":
      return "Claude is temporarily overloaded (HTTP 529).";
    case "model_not_found":
      return "Configured model is not available for this account; check AGENT_MODEL_* settings.";
    default:
      return kind;
  }
}

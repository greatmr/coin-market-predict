import type { z } from "zod";
import type { AgentToolset } from "./agent-tools.js";

export type AgentRole = "market_analyst" | "risk_reviewer" | "coordinator";

export type AgentErrorKind =
  | "auth_missing"
  | "authentication_failed"
  | "rate_limit"
  | "overloaded"
  | "billing_error"
  | "budget_exceeded"
  | "timeout"
  | "max_turns"
  | "invalid_output"
  | "model_not_found"
  | "sdk_error";

export interface AgentRequest<T> {
  role: AgentRole;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Structured data the prompt refers to (fixture runner reads it directly). */
  payload: unknown;
  outputSchema: z.ZodType<T>;
  toolset: AgentToolset;
  skills: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  effort: "low" | "medium" | "high";
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentResult<T> {
  ok: boolean;
  output: T | null;
  errorKind: AgentErrorKind | null;
  errorMessage: string | null;
  usage: AgentUsage;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  sessionId: string | null;
  toolCalls: Array<{ name: string; allowed: boolean }>;
  provider: "claude_agent_sdk" | "fixture";
  /** Diagnostics from the SDK init message (tools, skills, plugins, auth source). */
  init?: Record<string, unknown>;
}

export interface AgentRunner {
  readonly provider: "claude_agent_sdk" | "fixture";
  /** Whether the runner can make calls right now (e.g. credentials present). */
  availability(): { available: boolean; reason: string | null };
  run<T>(req: AgentRequest<T>): Promise<AgentResult<T>>;
}

export const AGENT_RUNNER = Symbol("AGENT_RUNNER");

export const emptyUsage = (): AgentUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

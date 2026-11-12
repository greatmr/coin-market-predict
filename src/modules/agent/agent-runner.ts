import type { z } from 'zod';

import type { ToolDef } from '../mcp/tool-def.js';

import type { AgentErrorKind } from './agent.constants.js';

/** DI token of the runner (the Claude Agent SDK in production, a fake in tests). */
export const AGENT_RUNNER = Symbol('AGENT_RUNNER');

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentRunRequest<T> {
  model: string;
  /** Tried when the model is overloaded or declines; null = none. */
  fallbackModel: string | null;
  effort: AgentEffort;
  maxTurns: number;
  /** Cost cap at list prices (the SDK's estimate). */
  maxBudgetUsd: number;
  timeoutMs: number;
  systemPrompt: string;
  prompt: string;
  /** Read-only tools, already bound to the coin under analysis. */
  tools: readonly ToolDef[];
  outputSchema: z.ZodType<T>;
  /** Aborts the run (server shutdown). */
  signal?: AbortSignal;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The SDK's estimate at list prices; a subscription is not billed per run. */
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number;
  durationApiMs: number | null;
  /** Models that answered (the fallback model appears here when it was used). */
  models: string[];
  refusalFallback: boolean;
  sessionId: string | null;
}

export interface AgentRunResult<T> {
  ok: boolean;
  output: T | null;
  errorKind: AgentErrorKind | null;
  errorMessage: string | null;
  /** Claude produced output: the run counts toward the limit even when it failed afterwards. */
  modelResponded: boolean;
  usage: AgentUsage;
  /** Tool calls the guard refused (anything outside the agent's read-only tools). */
  deniedTools: string[];
}

export interface AgentRunner {
  /** Whether a run can start at all (credentials present), with the reason when not. */
  availability(): { available: boolean; reason: string | null };
  run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>>;
}

export function emptyUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    numTurns: null,
    durationMs: 0,
    durationApiMs: null,
    models: [],
    refusalFallback: false,
    sessionId: null,
  };
}

/** What the owner sees for each failure (no secrets, no stack traces). */
export function describeAgentError(kind: AgentErrorKind): string {
  switch (kind) {
    case 'authentication_failed':
      return 'Claude rejected CLAUDE_CODE_OAUTH_TOKEN (invalid, expired or not allowed). Create a new one with `claude setup-token` and restart the server.';
    case 'billing_error':
      return 'Claude reported a subscription or billing problem for this token.';
    case 'rate_limit':
      return "The Claude subscription's usage limit is reached; try again later.";
    case 'overloaded':
      return 'Claude is overloaded at the moment; try again in a few minutes.';
    case 'model_not_found':
      return 'The configured model (AGENT_MODEL) is not available to this Claude account.';
    case 'invalid_request':
      return 'Claude refused the request as invalid.';
    case 'refusal':
      return 'Claude declined to analyse this request.';
    case 'timeout':
      return 'The analysis did not finish within AGENT_TIMEOUT_SECONDS.';
    case 'max_turns':
      return 'The agent used all its turns (AGENT_MAX_TURNS) before answering.';
    case 'budget_exceeded':
      return 'The run reached its cost cap (AGENT_MAX_BUDGET_USD).';
    case 'invalid_output':
      return "Claude's answer did not match the expected format.";
    case 'interrupted':
      return 'The run was interrupted (server shutdown or restart).';
    case 'sdk_error':
      return 'The Claude agent failed unexpectedly; see the server log.';
  }
}

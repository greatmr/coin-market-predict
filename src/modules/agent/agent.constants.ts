/**
 * Claude coin agent (docs/adr/0005-coin-agent.md): an owner-only, on-demand second opinion on one
 * coin. The value lists are the PostgreSQL enum types of migration M010; adding a value needs a
 * migration as well.
 */

/** Version of the agent's instructions, tools and output schema; stored on every analysis. */
export const AGENT_PROMPT_VERSION = 'coin-agent-1';

/** The agent's call on a pump within the horizon. A view for human review, never a signal. */
export const AGENT_OUTLOOKS = [
  'PUMP_LIKELY',
  'PUMP_POSSIBLE',
  'PUMP_UNLIKELY',
  'INSUFFICIENT_DATA',
] as const;
export type AgentOutlook = (typeof AGENT_OUTLOOKS)[number];

/** How sure the agent is of its outlook given the data. Not a probability. */
export const AGENT_CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AgentConfidence = (typeof AGENT_CONFIDENCES)[number];

export const AGENT_RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Why a run failed (stored as text; shown to the owner with `describeAgentError`). */
export const AGENT_ERROR_KINDS = [
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'overloaded',
  'model_not_found',
  'invalid_request',
  'refusal',
  'timeout',
  'max_turns',
  'budget_exceeded',
  'invalid_output',
  'interrupted',
  'sdk_error',
] as const;
export type AgentErrorKind = (typeof AGENT_ERROR_KINDS)[number];

/**
 * The outlook's horizon: the strategy's 7 × 24 h time exit (PDF p.26), the same 168 h the Star
 * Event Forward Test measures.
 */
export const AGENT_HORIZON_HOURS = 168;

/** Name of the agent's in-process MCP server; its tools are `mcp__coins__<tool>`. */
export const AGENT_MCP_SERVER = 'coins';

/** The SDK's own tool that returns the structured output (always allowed). */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** CMC ids of the market-regime references (Tier 2 BTC/ETH regime, PDF p.25). */
export const REGIME_ASSETS = [
  { cmcId: 1, symbol: 'BTC' },
  { cmcId: 1027, symbol: 'ETH' },
] as const;

/** pg_advisory_xact_lock key that serializes the limit check and the start of a run. */
export const AGENT_LOCK_KEY = 4_100_100_001;

/** A run still RUNNING this long after its timeout was lost (restart, crash) and is closed. */
export const AGENT_STALE_GRACE_MS = 120_000;

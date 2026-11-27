# ADR-0012: Owner chat with the analyst desk

Status: accepted (2026-11-27)

## Context
The owner wanted to talk to Claude about the panel: the review queue, a coin, the market, the risk
of a setup. The coin agent (ADR-0005) gives one structured view per coin; it cannot answer open
questions.

## Decision
- **One agent, three roles.** The "analyst desk" acts as market data analyst, pro trader and risk
  manager (`agent/chat/chat-prompt.ts`). It keeps the project's limits: no probability, price
  target, position size or order instruction.
- **Follows the strategy automatically.** The system prompt is rebuilt on every message from the
  strategy constants (`strategyBrief()`, shared with the coin agent) plus the rule versions of the
  forward test and the LBank observation. A strategy update reaches the next message with no other
  change. Each conversation stores the strategy fingerprint it began under; when it differs from the
  current one the page shows a notice and the prompt tells Claude to use the current rules and mark
  outdated earlier answers. The `get_strategy` tool returns the same text on demand.
- **Read-only, enforced in code.** `tools: []`, only the tools of `chat-tools.ts` (every one
  `scope: 'read'`; `buildChatTools` throws otherwise, a unit test pins this), `dontAsk` plus the
  PreToolUse guard, and the prompt tells it to refuse any request to change data. The chat service
  writes only its own `chat_conversation` / `chat_message` rows (M019).
- **Owner only**: permission `chat:use` (owner role only), the same OAuth-token-only runner and
  `buildAgentEnv()` allowlist as the coin agent.
- **Limit**: `CHAT_MAX_MESSAGES` (default 10) owner messages per conversation, checked under an
  advisory lock; a reply that fails before Claude answers does not use one. One reply at a time.
- **Model and effort** are chosen per message from `CHAT_MODELS` / `CHAT_EFFORTS` (Haiku has no
  effort setting). The reply is written in the background and the page polls, so a long reply does
  not hit proxy timeouts.

## Consequences
Chat output never feeds the pipeline, Tier 1, exports, Telegram or MCP. Any change to the chat
prompt or tools bumps `CHAT_PROMPT_VERSION`.

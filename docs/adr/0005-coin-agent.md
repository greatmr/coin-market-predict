# ADR-0005: Claude coin agent (owners, on demand) and the live TradingView chart

- Status: accepted (2026-11-12)
- Partly reverses: the retirement of the Claude Agent SDK review on 2026-11-05
  ([architecture.md § Retired components](../architecture.md#retired-components-2026-11-05)), in a
  narrower form

## Context
The operator asked for two additions to the coin details:

1. An agent built on Claude that, when asked, checks the market, the stored data, the coin and the
   strategy, and gives its own view on whether the coin will pump. Every answer is kept in the
   database as history. Only owners may use it, and at most 5 requests may run in 12 hours.
2. A live TradingView chart and live market data for each coin, loaded as soon as its details open.

The Tier 1 screen must stay deterministic and the outputs remain review material, not trading
signals (intend.md).

## Decision

### Agent (`src/modules/agent/`)
- **On demand only.** A run starts only when an owner presses _Ask Claude_ on the coin's Agent tab.
  Nothing is scheduled, and the pipeline, Tier 1 results, exports, Telegram and MCP never call or
  include the agent.
- **SDK and credential.** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, pinned) runs
  with the operator's Claude subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, from
  `claude setup-token`). Configuration validation refuses an API key in that variable, and the
  agent's process receives an allowlisted environment (`buildAgentEnv`) without
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, so it cannot fall back to API billing.
- **Least privilege.** No built-in tools (no shell, files or web). Four read-only tools run in
  process, each bound to the coin under analysis: `get_coin_trace` (the Tier 1 trace),
  `get_price_history` (hourly observations with exact summary changes), `get_market_regime`
  (BTC/ETH changes, scan breadth) and `get_forward_test_context` (star-event base rates and this
  coin's past events). Permission mode `dontAsk` plus a PreToolUse guard deny anything else; no
  filesystem settings, memory or other MCP servers are loaded; the prompt is delivered verbatim
  and coin names are embedded only as JSON values. Tool text is marked as untrusted.
- **Answer.** A JSON Schema–constrained answer, validated again with Zod: outlook
  (`PUMP_LIKELY`, `PUMP_POSSIBLE`, `PUMP_UNLIKELY`, `INSUFFICIENT_DATA`) for the next 7 × 24 h,
  confidence (LOW / MEDIUM / HIGH, not a probability), a headline, the agent's reasoning in its
  own words, factors for and against with the tool values they rest on, risks, data gaps, what to
  watch, and its read of the Tier 2 candle state and BTC/ETH regime. No probability, price
  target or position size.
- **Guardrails in code.** Confidence is capped at LOW on synthetic data or when the current
  observation is not OK, and at MEDIUM on an incomplete batch. The outlook is never changed. Every
  adjustment is stored as a note.
- **Limit.** At most `AGENT_MAX_RUNS` (5) runs in any rolling `AGENT_WINDOW_HOURS` (12), counted
  for all owners together, and one run at a time. The check and the start are serialized with a
  PostgreSQL advisory lock. A run counts from its start; a run that failed before Claude produced
  any output (credentials, outage) is released. Each run also has a turn cap, a timeout and a
  list-price cost cap.
- **History.** `agent_analysis` (migration M010): one row per run with the requester, the coin, the
  Tier 1 batch it read, model, effort, prompt and ruleset versions, every tool call with its input
  and output, usage, and the result or the failure reason. A trigger makes finished rows
  immutable. Deleting an account clears only the user link; the username stays. Runs left
  RUNNING by a restart are closed as `interrupted` after the timeout plus two minutes.
- **Access.** Permission `agent:use`, owner only (`modules/auth/permissions.ts`). Routes:
  `GET` and `POST /api/assets/:cmcId/agent`.
- **Model.** `claude-opus-5-5`, effort `high`, with `claude-opus-4-8` as the fallback for
  overload or a declined request (all configurable).

### Live chart (dashboard)
- TradingView offers no public market-data API. Its free widgets are the supported embed, and the
  self-hosted Charting Library needs a licence and our own data feed. The dashboard therefore
  uses the Advanced Chart and Symbol Info widgets.
- They are loaded as **sandboxed, cross-origin iframes** with the URL format of TradingView's embed
  script (`https://www.tradingview-widget.com/embed-widget/<id>/?locale=en#<settings>`), without
  running that script in the signed-in dashboard. The CSP gains only
  `frame-src https://www.tradingview-widget.com`; `script-src` stays `'self'`.
- The chart opens at the top of the Review tab with daily candles in UTC (CMC days close at
  00:00 UTC).
- TradingView carries LBank perpetuals (`LBANK:<BASE>USDT.P`) but not LBank Spot (checked
  2026-11-12), so every symbol is a labelled proxy. In order:
  1. spot markets CMC lists for this CMC id on an exchange TradingView carries, USD quotes and
     higher volume first (`read-model/tradingview.ts`; the exchange map was verified against
     TradingView's symbol search);
  2. the LBank perpetual;
  3. TradingView's ticker index (`CRYPTO:<SYMBOL>USD`), which matches by ticker only.

  _Use in review form_ copies the symbol, URL, UTC time zone and a proxy reason into the Tier 2
  fields; the reviewer still checks them.

## Consequences
- The project calls an LLM again, but only when an owner asks. Screening, exports, Telegram and
  MCP stay deterministic and unchanged.
- Each run uses the operator's Claude plan limits. The cost shown is the SDK's list-price
  estimate, not a bill.
- The agent's view is an opinion: not calibrated and not back-tested. What star events actually
  did is measured by the forward test, not by the agent.
- The Docker image grows by the Agent SDK's native CLI binary (about 330 MB). The Dockerfile drops
  the unused musl build.
- TradingView data reaches only the viewer's browser. Nothing from it is stored or used by Tier 1.
  If TradingView changes its embed URL format, only `tvFrame` in `public/app.js` needs updating.

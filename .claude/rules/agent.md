---
paths:
  - "src/modules/agent/**"
  - "src/modules/dashboard/agent.controller.ts"
  - "src/modules/read-model/tradingview.ts"
  - "public/**"
---
# Claude coin agent and live chart (docs/adr/0005-coin-agent.md)

Agent
- On demand only: an owner's request (`agent:use`). Never call it from the pipeline, scans,
  exports, Telegram or MCP, and never let its output change stored data or Tier 1 results.
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` only; the process gets `buildAgentEnv()` (allowlist). Never pass
  `process.env`, never add `ANTHROPIC_API_KEY` fallbacks.
- Least privilege: `tools: []`, only the read-only tools in `agent-tools.ts`, bound to the coin
  (no id parameters), `permissionMode: 'dontAsk'` + the PreToolUse guard, `settingSources: []`,
  `strictMcpConfig`, `verbatimPrompts`. Untrusted text goes in as JSON values only.
- Numbers the agent reads are computed in code with exact decimals (`agent-data.ts`); thresholds in
  the prompt come from `modules/strategy` constants. Confidence ceilings live in `guardrails.ts`.
- No probability, price target or position size in the schema. Any change to the prompt, tools or
  schema bumps `AGENT_PROMPT_VERSION`.
- The limit (`AGENT_MAX_RUNS` per `AGENT_WINDOW_HOURS`, one run at a time) is checked under the
  advisory lock in `AgentService.start`. History rows are immutable once finished (M010 trigger).

Live chart
- TradingView widgets only as sandboxed cross-origin iframes (`tvFrame` in `public/app.js`); no
  third-party `<script>`, CSP `frame-src` lists only the widget origin.
- Symbols are proxies (TradingView has no LBank Spot): CMC venue markets for the CMC id first,
  labelled fallbacks after. Never match an asset by ticker alone without saying so.

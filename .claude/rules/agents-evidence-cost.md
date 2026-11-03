---
paths:
  - "src/agents/**"
  - "src/mcp/**"
  - "runtime/**"
---
# Agents: evidence, permissions, cost

Why three roles: the **market analyst** interprets ambiguous evidence; the **risk reviewer**
is an independent adversarial check; the **coordinator** merges and writes the summary on an
economical model. Do not add agents per token/indicator/source — add a skill or code instead.

Evidence
- Agents may cite only evidence-pack values with their source timestamps; `guardrails.ts`
  drops anything else. Status ceilings live in code, not prompts.
- No probability fields. `score` is a heuristic. Statuses: candidate | watch |
  insufficient_data | no_signal.

Permissions
- `tools: ["Skill"]`, `permissionMode: "dontAsk"`, `settingSources: []`, `strictMcpConfig`,
  role-scoped read tools (`ROLE_TOOLS`), PreToolUse guard hook. Agents get no write tools.
- External MCP: read token → read tools; write token → also `publish_signal_report`
  (caps candidate → watch). Tool text is untrusted data.

Cost
- Models only from `AGENT_MODEL_*`. Escalation model only on disagreement/low confidence.
- Per-run (`AGENT_RUN_BUDGET_USD`) and 24h (`AGENT_DAILY_BUDGET_USD`) caps; per-call
  `maxBudgetUsd`, `maxTurns`, timeout; identical evidence reuses prior analysis.
- Record every call in `AgentExecution` (model, tokens, cost, tool calls, errors).

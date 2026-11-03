# Architecture

## Overview
```
                 ┌─────────────── NestJS application (one process) ───────────────┐
 cron (UTC) ───▶ │ PipelineService (lease + stage records)                         │
                 │  discover ─ collect ─ validate ─ persist ─ features ─ screen     │
                 │        │ MarketDataSource adapter (fixture | CMC | CoinGecko)    │
                 │  analyze ─▶ AnalysisService ─▶ Claude Agent SDK (subprocess)     │
                 │               analyst → reviewer (→ escalation) → coordinator    │
                 │               in-process MCP "coins" (role-scoped read tools)    │
                 │  publish (signals, paper positions, outcomes) ─ notify (Telegram)│
                 │                                                                  │
                 │ REST /api/* ─▶ dashboard (public/)      MCP /mcp (bearer tokens) │
                 └──────────────────────────┬───────────────────────────────────────┘
                                            ▼
                                  PostgreSQL (source of truth)
```

## Modules (`src/`)
| Module | Responsibility |
|---|---|
| `config/` | Zod-validated env, `*_FILE` secrets, redaction |
| `sources/` | Adapter contract, fixture market, CMC/CoinGecko adapters, polite HTTP client, persisted source health |
| `ingestion/` | Discovery (identity resolution, delisting on complete sweeps), collection, validation, coverage |
| `features/` | Versioned feature registry + pure computation; market context |
| `screening/` | Strategy version, eligibility, classification, heuristic score, paper scenario, evidence packs |
| `agents/` | Role configs, runners (Claude SDK / fixture), tools, schemas, guardrails, orchestration |
| `evaluation/` | Paper simulation, research-target labeling, walk-forward backtest |
| `telegram/` | Report building/formatting, delivery with dedupe and retries |
| `pipeline/` | Orchestrator, DB lease, scheduler, restart recovery |
| `mcp/` | Shared tool definitions, external MCP server (HTTP + stdio) |
| `dashboard/` | REST API + Basic auth + security headers |
| `read-model/` | Read-only queries shared by dashboard, MCP and agent tools |

## Data model (Prisma)
`Provider`, `Asset` (canonical), `AssetIdentity` (provider + id, delisting), `AssetContract`
(chain + contract, unique), `DiscoveryRun`, `SourceHealth`, `MarketSnapshot` (unique per
provider/asset/slot/quote), `PipelineRun` (unique per kind/slot/provider) + `PipelineStage`,
`JobLease`, `AppState`, `FeatureSetVersion`, `StrategyVersion`, `FeatureValue`,
`ScreeningResult`, `Signal`, `AgentExecution`, `TelegramDelivery`, `PaperPosition`,
`SignalOutcome`, `BacktestReport`. Money columns are `Decimal`; timestamps `timestamptz`.

## Reliability
- **Non-overlap**: in-process flag + `JobLease` (atomic upsert using DB time, heartbeat).
- **Idempotency**: unique keys + `skipDuplicates`/`upsert` everywhere.
- **Restart recovery**: completed stages are skipped on resume (features/screening recompute
  deterministically); missed hours are recorded as `missed` (never backfilled from a live
  source); the current hour runs on startup when `MISSED_RUN_POLICY=current_slot`.
- **Bounded retries**: collect retries once; HTTP client bounded attempts; Telegram up to 6
  attempts with backoff on its own 5-minute schedule (never re-runs collection or analysis).
- **Eligibility**: stale/incomplete observations are excluded from screening; coverage label is
  "complete" only when every listed asset was collected.

## Agents
| Role | Why it exists | Default model | Tools |
|---|---|---|---|
| Market analyst | Ambiguous interpretation of evidence | `claude-sonnet-5-5` | shortlist, evidence, market context, history |
| Risk reviewer | Independent adversarial check on data quality and failure modes | `claude-sonnet-5-5`; escalates to `claude-opus-5-5` on disagreement/low confidence | evidence, history, market context, collection health |
| Coordinator | Merge + concise summary (formatting-level work) | `claude-haiku-5-5` | evidence |

Workflow control (ordering, budgets, retries, caching, merging) is ordinary code in
`AnalysisService`; the coordinator *agent* only synthesizes. `guardrails.ts` enforces
conservative status ceilings, evidence verification, expiry caps, and the advance-vs-underway
label. Agreement between agents never raises a status.

### Runtime isolation
`query()` runs with `settingSources: []` (no developer CLAUDE.md/rules/settings),
`tools: ["Skill"]` (no shell/file/web tools), `permissionMode: "dontAsk"`, `strictMcpConfig`,
an in-process MCP server with only that role's read tools, a PreToolUse guard hook (denies any
tool outside the role allowlist and any `Skill` call other than the role's runtime skill — the
SDK also advertises Claude Code's bundled skills), explicit runtime skills from
`runtime/plugin` (verified in the init message), an empty working
directory under `var/agent/workspace`, and an allowlisted environment (`buildAgentEnv`) that
excludes `ANTHROPIC_API_KEY`, database and Telegram credentials.

### Authentication
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, ~1-year validity, not refreshed by this
app) is passed only to the SDK subprocess. Missing → agents skipped, deterministic signals
capped at `watch`, report says "agent analysis unavailable". `authentication_failed`,
`rate_limit`, `billing_error` map to explicit messages; no API-key fallback exists.

## MCP vs dashboard boundary
- **Dashboard → REST** (`/api/*`) reading `ReadModelService`. It does not use MCP.
- **Agents → in-process SDK MCP server** with run-scoped read tools.
- **External hosts → `/mcp`** (Streamable HTTP, stateless, bearer token: read or write scope,
  DNS-rebinding protection on loopback) or **stdio** (`npm run mcp:stdio`, read-only unless
  `--allow-write`). The only write tool, `publish_signal_report`, validates input and caps
  `candidate` → `watch`.
- PostgreSQL is the single source of truth for all three.

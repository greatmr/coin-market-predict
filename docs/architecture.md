# Architecture

## Overview
```
                 ┌─────────────── NestJS application (one process) ───────────────┐
 cron (UTC) ───▶ │ PipelineService (lease + stage records)                         │
                 │  discover ─ collect ─ history ─ features ─ screen               │
                 │        │ MarketDataSource adapter (fixture | CMC API/web | CoinGecko)    │
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
| `sources/` | Adapter contract, fixture market, CMC API/website and CoinGecko adapters, shared website queue, polite HTTP client, persisted source health |
| `ingestion/` | Discovery (identity resolution, delisting on complete sweeps), collection, validation, coverage, genuine-history backfill, classification |
| `features/` | Versioned feature registry + pure computation; market context |
| `screening/` | Strategy version, screen universe (`universe.ts`), eligibility, classification, heuristic score, paper scenario, evidence packs |
| `agents/` | Role configs, runners (Claude SDK / fixture), tools, schemas, guardrails, orchestration |
| `evaluation/` | Paper simulation, research-target labeling, walk-forward backtest |
| `telegram/` | Report building/formatting, delivery with dedupe and retries |
| `pipeline/` | Orchestrator, DB lease, scheduler, restart recovery, storage retention |
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

## Pipeline stages
| Stage | What it does |
|---|---|
| `discover` | Listing sweep when due (`DISCOVERY_INTERVAL_HOURS`): identities, contracts, classes, delisting on complete sweeps |
| `collect` | One validated snapshot per listed coin for the UTC hour (website: one 10k-row listing request) |
| `history` | Genuine chart history for coins that would be eligible but lack t−1h/t−2h (bounded, resumable; failures never fail the run) |
| `features` | Features for the screen universe only; market context; exclusion counts for the rest |
| `screen` | Deterministic eligibility, classification, score, pump chance + reasons, shortlist |
| `vmc` | Six-month volume / market cap baselines for the pump watchlist (non-fatal) |
| `analyze` | Agents review the shortlist (≤ `SHORTLIST_SIZE`) with pump, 3-day and VMC context and give buy / hold / sell; code combines into buy / watch / avoid |
| `publish` | Signals, paper positions, outcomes |
| `notify` | Telegram report (dry run by default); retention runs afterwards |

**Progress.** Each stage logs `[███░░░░░░] n/9 stage · done in Xs`, and `PipelineRun.currentStage`
plus `PipelineStage` rows drive the dashboard's step bar (polled every 5 s while a run is active).
Results and the Telegram report appear only when the run finishes (typically 4–5 min, mostly the
agent review).

**Telegram report.** One compact message: header, one-sentence agent summary, the watchlist table
(every coin), and detail cards only for BUY or HIGH-pump coins (max 3). Everything else is on the
dashboard.

**Telegram access.** The owner is `TELEGRAM_CHAT_ID`. Anyone else who messages the bot is held as
*pending* and the owner is notified with `/approve <id>`, `/deny <id>`. Approved members receive
the hourly report (one `TelegramDelivery` row per chat; a failing recipient never blocks the
others) and can use `/report`, `/status`, `/vmc`, `/help`. Only the owner can `/run`, `/users`,
`/approve`, `/deny`, `/remove`. Denied chats are ignored; groups cannot request access. State lives
in `AppState` key `telegram.access` (`src/telegram/access.service.ts`). Sharing reports with other
people is the "redistribution" decision in `intend.md` (#3): confirm the data provider's terms.

## Storage and retention
Snapshot rows cost ~870 bytes (with indexes); the full website listing is ~8k coins, about
7 MB per hour. Rules (`src/pipeline/retention.service.ts`):
- Every listed coin: one `MarketSnapshot` per UTC hour (unique key, idempotent).
- Only the screen universe (benchmarks + non-excluded coins at or above the market-cap floor,
  ~1k coins) gets `FeatureValue` and `ScreeningResult` rows; the rest are counted per run in
  `PipelineRun.metrics.outsideReasons`. These rows are recomputable from snapshots.
- After `RETENTION_DETAIL_DAYS` (default 30): coins outside the floors keep the first snapshot of
  each UTC day — a genuine observation, never an aggregate — unless they qualified within ±72 h
  (look-back and outcome windows stay intact for floor-crossers); feature rows and
  non-shortlisted screening rows are pruned. A persisted watermark makes this resumable.
- `RETENTION_SNAPSHOT_DAYS > 0` still deletes everything older. Signals, paper positions, runs
  and VMC tables are never pruned here.
Approximate footprint with the defaults (8k coins, ~1k in the screen universe): a rolling
~6 GB of 30-day detail (tail snapshots ~4.3 GB, derived rows ~1.4 GB) plus ~11 GB/year of kept
history (universe hourly ~9 GB, tail daily ~2 GB). Storing every coin's snapshot, feature and
screening rows hourly without this policy would grow by roughly 250 GB/year.

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

## CMC website collection

`CmcWebModule` supplies one shared `CmcWebClient` to the main source adapter and VMC module.
The main adapter reads the whole listing with `limit=CMC_WEB_LISTING_PAGE_SIZE` (10,000: all
~8k coins in one response). Multi-page sweeps sorted by market cap are unstable among the
thousands of coins tied at zero cap, so they are a fallback with a small boundary overlap and are
reported as partial when coins repeat or vanish. The `history` stage calls the seven-day chart per
coin (~15-minute samples) only for strategy-eligible coins that lack the previous hours.
It reads coin pages' embedded Next.js data and the website listing/detail/history/chart JSON
endpoints. A bounded cache reduces repeated calls; `PoliteHttpClient` provides sequential
requests, persisted monthly budgets/cooldowns, backoff, Retry-After and denial suspension.
HTTP-200 application errors are normalized for retry decisions while VMC raw storage keeps
the original HTTP status and body. VMC daily data uses OHLCV; chart hourly points use rolling
24h volume and circulating cap. Raw-response hashes and existing revision tables preserve
provenance. Main website snapshots flow through ingestion, features, screening and agent
read tools just like the other sources. See `docs/volume-mcap.md` for routes and setup.

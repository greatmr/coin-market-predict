# Architecture

The system implements the **Two-Tier VMC strategy** ([strategy-two-tier-vmc.md](strategy-two-tier-vmc.md)):
an hourly, deterministic Tier 1 screen over CoinMarketCap data, and a Tier 2 human chart review
with an optional manual LBank Spot trade plan. No component places orders or ranks by predicted
return. The only LLM call is the Claude coin agent, run when an owner asks for one coin's view
([ADR-0005](adr/0005-coin-agent.md)); it never changes stored data or the screen's results.

## Overview

```
                 ┌───────────────────── NestJS application (one process) ─────────────────────┐
 cron (UTC) ───▶ │ PipelineService (DB lease + pipeline_stage rows), one run per UTC hour        │
                 │  discover ─ collect ─ lbank ─ daily ─ scan ─ venues ─ export ─ notify ─ forward│
                 │     │  MarketDataSource (listing)    Tier1Source (daily rows, LBank / asset    │
                 │     │  fixture | CMC website | CMC API | CoinGecko      market pairs)          │
                 │  ScanService: eligibility → VMC windows → pass/stars → queue  (StrategyModule) │
                 │  ExportService: CSV per sheet + manifest (sha256)                              │
                 │  ReviewService: append-only Tier 1 / Tier 2 review records, LBank decisions    │
                 │  ForwardTest: star events from the published queue, daily High update          │
                 │                                                                                │
                 │ REST /api/* ─▶ web (front/, nginx)   MCP /mcp + stdio (read-only)   Telegram   │
                 └──────────────────────────────────────┬─────────────────────────────────────────┘
                                                        ▼
                                              PostgreSQL (source of truth)
```

## Modules (`src/`)

Layout and database conventions follow the operator's standard NestJS + TypeORM backend
([ADR-0001](adr/0001-typeorm-modular-layout.md)); the strategy is a module of its own
([ADR-0002](adr/0002-strategy-module-boundary.md)). Each domain module keeps its entities in
`entities/` and its request DTOs in `dto/`; unit specs sit next to the code.

| Path                                | Responsibility                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`, `cli.ts`, `mcp-stdio.ts` | Entry points: web server + scheduler, CLI, MCP over stdio. All compose `AppModule`                                                                                                                                                                                                                                                                                                 |
| `config/`                           | Zod-validated env (`env.validation.ts`), `*_FILE` secrets, `AppConfigModule` (`APP_CONFIG`)                                                                                                                                                                                                                                                                                        |
| `common/`                           | Exact decimals (80 significant digits) and UTC dates (`utils/`), the CSV writer (`files/`), redaction, Basic auth, write guard, security headers (`security/`), `{ data, errors }` envelope, error codes, exception filter, Zod pipe, entity column helpers                                                                                                                        |
| `database/`                         | TypeORM options shared by the app and the CLI, naming strategy, entity and migration registries, raw-SQL migrations                                                                                                                                                                                                                                                                |
| `health/`                           | `GET /healthz` liveness                                                                                                                                                                                                                                                                                                                                                            |
| `modules/strategy/`                 | **The Two-Tier VMC rules**: `RULESET_VERSION`, thresholds, reason codes and status sets (`strategy.constants.ts`); Tier 1 eligibility, VMC arithmetic, LBank resolution, venue summary, queue order (`tier1/`); Tier 2 review and trade-plan rules (`tier2/`); overrides; `StrategyService`. Pure, no I/O; used only through `index.ts`                                            |
| `modules/sources/`                  | `MarketDataSource` (hourly listing) and `Tier1Source` (daily history, LBank Spot pairs, asset market pairs) adapters: synthetic fixture, CMC website, CMC Basic API, CoinGecko; polite HTTP client with budgets and circuit state persisted in `source_health`                                                                                                                     |
| `modules/ingestion/`                | Discovery (identity, contracts, delisting on complete sweeps), hourly collection, validation, heuristic classification, coverage; `crawl_batch` (rank continuity), `market_snapshot`, `cmc_asset` with change log                                                                                                                                                                  |
| `modules/daily-metrics/`            | Completed UTC daily rows with every revision, per-coin fetch state, manual CSV import                                                                                                                                                                                                                                                                                              |
| `modules/venues/`                   | LBank Spot pair list, CMC Markets venue rows, listing events, reviewer decisions, mapping tasks                                                                                                                                                                                                                                                                                    |
| `modules/scan/`                     | Tier 1 scan of a batch with the strategy (`scan_run`, `scan_result`)                                                                                                                                                                                                                                                                                                               |
| `modules/forward-test/`             | Legacy Star Event Forward Test since the cutover ([forward-test.md](forward-test.md), [ADR-0004](adr/0004-forward-test-module.md)): trigger on the published Review Queue, automatic `forward_test_watchlist`, daily High update with revisions, versioned outcomes, star-group report and export. Pure rules in `forward-rules.ts` / `cohort.ts`                                  |
| `modules/star-events/`              | The star-event rule shared by both trackers (`validateTrigger`, the published-queue reader) and `signal_cutover`, the UTC-midnight cutover that routes each sighting to exactly one tracker ([ADR-0009](adr/0009-lbank-spot-observation.md))                                                                                                                                       |
| `modules/lbank-observation/`        | LBank Spot Price Observation ([lbank-spot-observation.md](lbank-spot-observation.md), rules `lbank-spot-obs-2`): intake of post-cutover events into its own tables with the proven start (scan commit), LBank's public REST API (or a synthetic fixture), shared 1-minute candles, checked trade minutes and day archives per pair, evidence at the signal, the first-trade reference and trade-verified extremes / gaps / freshness over exactly [start, start + 168 h), its own job and lease. Pure rules in `observation-rules.ts`, `observation-timing.ts` |
| `modules/exports/`                  | CSV per sheet + SHA-256 manifest                                                                                                                                                                                                                                                                                                                                                   |
| `modules/reviews/`                  | Append-only Tier 1 / Tier 2 reviews and LBank decisions, validated by the strategy's Tier 2 rules                                                                                                                                                                                                                                                                                  |
| `modules/pipeline/`                 | Orchestrator, DB lease, scheduler, restart recovery, storage retention                                                                                                                                                                                                                                                                                                             |
| `modules/telegram/`                 | Hourly summary formatting and delivery (dedupe, retries), bot commands, access control                                                                                                                                                                                                                                                                                             |
| `modules/auth/`                     | Dashboard users (owner / analyzer / reviewer), scrypt passwords, sessions, the role → permission table and the `/api` guard ([ADR-0003](adr/0003-dashboard-users.md))                                                                                                                                                                                                              |
| `modules/read-model/`               | Read-only queries shared by dashboard, MCP and Telegram (sheets, calculation traces, batches, exports); TradingView chart symbols for the coin details (`tradingview.ts`)                                                                                                                                                                                                          |
| `modules/agent/`                    | Claude coin agent, owners only, on demand ([ADR-0005](adr/0005-coin-agent.md)): Claude Agent SDK runner with an allowlisted environment and the subscription token, four read-only tools bound to one coin, structured answer + confidence guardrails, the rolling run limit, `agent_analysis` history                                                                             |
| `modules/dashboard/`                | The REST controllers and DTOs behind `/api/*` — the only module with HTTP routes besides `health` and `mcp`                                                                                                                                                                                                                                                                        |
| `modules/mcp/`                      | Read-only MCP tools over HTTP (bearer token) and stdio                                                                                                                                                                                                                                                                                                                             |
| `modules/app-state/`                | Small durable key/value state (`app_state`)                                                                                                                                                                                                                                                                                                                                        |

## Pipeline stages

| Stage      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | On failure                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `discover` | Listing sweep when due (`DISCOVERY_INTERVAL_HOURS`): identities, contracts, classes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | logged; collection continues                                                                                                                                             |
| `collect`  | Every listed coin read and validated for the UTC hour (a value outside its column's range is stored as NULL with a reason and the `value_out_of_range` flag, never a failed insert; website: one `limit=10000` request; a read in which CMC gives one rank to two coins is read again before anything is stored, up to 3 times 60 s apart, bypassing the response cache, and the stored read's receive time is its crawl time); stores snapshots of ranks 1–1200 only (D4) and records the `CrawlBatch` (`collected` = every coin read, `stored`; COMPLETE only if the whole listing was read and ranks 1–1200 are contiguous and unique) and syncs `CmcAsset` metadata | retried once, then a FAILED batch is recorded and the run fails                                                                                                          |
| `lbank`    | Reuses the stored LBank Spot markets list until it is `LBANK_PAIRS_REFRESH_DAYS` (30) old, then fetches it again; records `LISTED`/`ABSENT` pair events on each complete fetch. Manual refresh: dashboard / `lbank:refresh`                                                                                                                                                                                                                                                                                                                                                                                                                                             | non-fatal: a failed refresh keeps the previous list until `LBANK_PAIRS_MAX_AGE_DAYS` (35); without a usable list every LBank status is UNKNOWN and the queue is withheld |
| `daily`    | Refreshes completed UTC daily rows (`TIER1_DAILY_LOOKBACK_DAYS`) for screen candidates lacking T−1, once per UTC day, bounded by assets / minutes / request budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | non-fatal: missing days make only the affected windows N/A                                                                                                               |
| `scan`     | Deterministic Tier 1 evaluation of every coin in the batch; writes `scan_run` + `scan_result` rows, queue order, warnings, LBank mapping tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | fatal (the run fails; the previous scan stays the latest valid one)                                                                                                      |
| `venues`   | CMC Markets venue rows for review candidates (≤ `TIER1_VENUE_MAX_ASSETS_PER_RUN`, refreshed every `TIER1_VENUE_REFRESH_HOURS`); then the LBank Futures and Bithumb Spot markets lists when `EXCHANGE_LISTS_REFRESH_HOURS` (24) old — listing attributes for the forward-test tab, never read by the scan ([ADR-0007](adr/0007-exchange-listings.md))                                                                                                                                                                                                                                                                                                                    | non-fatal: rows show `VENUE_DATA_PENDING`; an unverified exchange list shows its listings as Unknown                                                                     |
| `export`   | CSV per sheet + manifest into `TIER1_EXPORT_DIR`; written to a temp directory and renamed only on success                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | non-fatal: the previous export remains the latest valid file                                                                                                             |
| `notify`   | Telegram summary of the batch (dry run by default)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Telegram retries on its own 5-minute schedule                                                                                                                            |
| `forward`  | Legacy forward test: one event per new (coin, UTC date, stars) of the published queue detected before the cutover; the daily High update when a UTC day has closed (or missing Highs are due for a retry), with one hourly-history request per coin and signal date whose daily High came before detection (rules `star-forward-2`), then its export; retention runs afterwards                                                                                                                                                                                                                                                                                         | non-fatal: outcomes keep their previous version; the next run tries again                                                                                                |
| `observe`  | LBank Spot Price Observation intake: for a batch detected at or after the cutover, one event per new (coin, UTC date, stars) with its observation in one transaction; rows that open none are kept with reasons. LBank candles, evidence and results come from the observation's own job (`LBANK_OBSERVATION_CRON`, lease `lbank-observation`)                                                                                                                                                                                                                                                                                                                          | non-fatal: the run is `partial`; the routing check reports a batch without intake                                                                                        |

A run whose non-fatal stages degraded finishes `partial` with the reasons in
`pipeline_run.metrics.degraded`. Each stage logs `[███░░░░░] n/10 stage · done in Xs`;
`pipeline_run.current_stage` and `pipeline_stage` rows drive the dashboard step bar.
`npm run cli -- tier1:scan --batch <id>` (or the dashboard's _Reprocess latest batch_) recomputes
a stored batch from saved data under the same lease, without crawling.

## Data model (TypeORM, PostgreSQL)

Tables are snake_case; entities live in each module's `entities/` and are registered in
`src/database/entities.ts`. The schema is created only by the raw-SQL migrations in
`src/database/migrations/` (M001 enum types · M002 platform · M003 market data · M004 daily
metrics · M005 venues · M006 scan and reviews · M007 users · M008 forward test · M009 weighted
star ranking · M010 coin agent history), applied with
`npm run db:migrate`; a test fails
when entities and migrations disagree. Conventions and their reasons:
[ADR-0001](adr/0001-typeorm-modular-layout.md).

| Table                                                                    | Module        | Purpose                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`, `source_health`                                              | sources       | Source registry (live or not, terms, attribution); circuit state and request budget per source                                                                                                                                                                                                           |
| `asset`, `asset_identity`, `asset_contract`, `discovery_run`             | ingestion     | Provider-neutral identity (UUID), provider ids, chain + contract, discovery sweeps                                                                                                                                                                                                                       |
| `crawl_batch`                                                            | ingestion     | One per provider + UTC hour: crawl time, status + reasons, listed / collected counts, missing and duplicate ranks                                                                                                                                                                                        |
| `market_snapshot`                                                        | ingestion     | One validated observation per coin per UTC hour, with `null_reasons`                                                                                                                                                                                                                                     |
| `cmc_asset`, `cmc_asset_change`                                          | ingestion     | CMC-id-keyed metadata (symbol, name, slug, tags, date added, platform) and every change to it                                                                                                                                                                                                            |
| `daily_metric`, `daily_metric_revision`, `daily_fetch_state`             | daily-metrics | Effective completed-day row per coin and date, every revision with source route, parameters and response SHA-256 (and, since M008, the source's time of the day's High / Low), per-coin fetch state                                                                                                      |
| `venue_crawl`, `venue_pair_event`                                        | venues        | LBank Spot pair feed, asset market-pair, LBank Futures and Bithumb Spot crawls (pairs as JSON; kinds since M012) and LBank listing / absence events                                                                                                                                                      |
| `venue_decision`, `venue_mapping_task`                                   | venues        | Reviewer decisions (mapping confirmed / rejected, verified tradable, not tradable) and open ambiguous-ticker tasks                                                                                                                                                                                       |
| `scan_run`, `scan_result`                                                | scan          | One scan per batch (queue status, counts, warnings, export state) and one row per coin with every value, status, reason, the daily window used, inputs hash, ruleset and config versions, and the weighted star ranking (points, completeness, strength, `ranking_ruleset_version`) behind `queue_order` |
| `review`                                                                 | reviews       | Append-only Tier 1 / Tier 2 review revisions with the Tier 1 snapshot they were made against                                                                                                                                                                                                             |
| `forward_test_watchlist`, `forward_event`                                | forward-test  | One row per coin with events (automatic, no approval); one event per (coin, UTC date, star count) with its immutable detection snapshot (a database trigger refuses changes), window and tracking status                                                                                                 |
| `forward_high`, `forward_outcome`, `forward_day0_capture`                | forward-test  | Each included day's High per event and source revision, plus the signal day's hourly-measured rows with their capture (superseded rows kept); versioned outcomes (peak, return, coverage, extension flag); immutable hourly captures of signal dates                                                     |
| `forward_trigger_run`, `forward_trigger_rejection`, `forward_update_run` | forward-test  | Each reading of a published queue (created / ignored / rejected), rejected rows with reasons, each daily High update                                                                                                                                                                                     |
| `pipeline_run`, `pipeline_stage`, `job_lease`                            | pipeline      | Runs per slot with stage status and metrics; the lease that prevents overlapping runs                                                                                                                                                                                                                    |
| `telegram_delivery`                                                      | telegram      | Every report part per recipient with status and attempts                                                                                                                                                                                                                                                 |
| `app_state`                                                              | app-state     | Small durable values (Telegram access list and offset, retention watermark, fixture anchor)                                                                                                                                                                                                              |
| `agent_analysis`                                                         | agent         | One row per Claude coin-agent run: requester, coin, Tier 1 batch read, model and prompt version, every tool call with its output, usage, the structured view or the failure; immutable once finished (trigger); counted for the run limit ([ADR-0005](adr/0005-coin-agent.md))                           |

Closed value sets (statuses, classes, decisions) are PostgreSQL enum types whose values come from
the code; the strategy's sets come from `modules/strategy`. Every reference to another row is a
foreign key: required ones `RESTRICT`, run-owned rows `CASCADE`, optional provenance links
`SET NULL`. Prices are `numeric(38,18)`, caps and volumes `numeric(38,4)` or `(38,8)` as the source
supplies them, ratios and multiples `numeric(65,30)`; all are read as exact decimals, never
floats. Timestamps are `timestamptz` (UTC); calendar days are `date`.

## Determinism and traceability

- Every ratio is computed from stored source values with exact decimal arithmetic; a pass is
  `current ≥ 1.5 × mean`, evaluated without rounding (exactly 1.5× is YES).
- `scan_result` stores the inputs hash, `RULESET_VERSION`, the configuration version (rules +
  override file hash), the daily revision ids used, and the scan time; re-running a scan over
  unchanged inputs reproduces the same rows. Since D4 only Review Queue rows are stored; any other
  coin with a stored snapshot is traced by evaluating it on request with the same code and inputs
  (`ScanService.evaluateCoins`, trace `evaluation.mode = on_request`, nothing written).
- The as-of time of a scan is the batch's crawl time, so a replay never uses rows that appeared
  later (A1). Daily rows revised after a scan are shown as "revised since" in the trace.
- `GET /api/assets/:cmcId/trace` (dashboard drawer, `tier1:trace`, MCP `get_asset_trace`) prints
  each window's dates, values and formula, e.g. `mean_3d = (0.1 + 0.1 + 0.1) / 3 = 0.1`.

## Storage and retention

Operator decision D4 ([ADR-0008](adr/0008-storage-scope.md)): store per coin only what the
strategy found. Every listed coin (~8k on the website) is still read, validated and screened every
UTC hour, and stays in the coin registry (`asset`, `asset_identity`, `cmc_asset`); what is stored:

- `market_snapshot`: ranks 1–1200 only (the Tier 1 band, the ranks the continuity check needs,
  BTC/ETH). A coin ranked above 1200 or unranked is counted in `crawl_batch.collected` but not
  stored (`crawl_batch.stored` counts what was).
- `scan_result`: Review Queue rows only (withheld queues included, marked by their queue status).
  Eligible coins without a star, NEEDS_REVIEW and EXCLUDED coins are counted on `scan_run.counts`
  (by status and reason, stars, N/A reasons, the ids lacking daily rows) and traced on request.
- Daily rows exist only for ELIGIBLE coins (A11), and are never pruned: they are the 3/7/30-day
  baselines.

Retention (`src/modules/pipeline/retention.service.ts`, after every run):

- After `RETENTION_DETAIL_DAYS` (default 7) a snapshot stays only when a stored queue row used it,
  a forward-test event references it (its immutable detection snapshot) or it is BTC/ETH; every
  other one is deleted (daily baselines live in `daily_metric`, not in snapshots).
- Rows stored under the earlier policy are left alone until the operator runs `storage:prune` once
  after a backup: until then hourly retention deletes no snapshot (`legacyPending` in the run's
  retention report). `storage:prune` is a dry run without `--apply`; with it, it deletes slot by
  slot under the pipeline lease and `--vacuum` returns the space (docs/operator-guide.md).
- Export files older than `EXPORT_RETENTION_DAYS` (default 7) are deleted; the database keeps
  every stored result, so an export can be regenerated with `tier1:export --batch <id>`.
- `RETENTION_SNAPSHOT_DAYS > 0` deletes older snapshots outright (default 0), forward-test
  snapshots excepted.
- Review Queue rows, reviews, decisions, daily rows, crawl batches, scan runs, the coin registry
  and every forward-test table (events, Highs, outcomes, triggers, rejections, update runs) are
  never pruned.

## Reliability

- **Non-overlap**: in-process flag + `job_lease` (atomic upsert using DB time, heartbeat). Scans,
  reprocessing and exports run under the same lease.
- **Idempotency**: unique keys + `INSERT … ON CONFLICT DO NOTHING` (first write wins) or
  `… DO UPDATE` (upsert); daily rows only gain a revision when normalized values change; a scan
  replaces its own rows in one transaction.
- **Restart recovery**: completed stages are skipped on resume; missed hours are recorded as
  `missed` and never backfilled from a live source; the current hour runs on startup when
  `MISSED_RUN_POLICY=current_slot`.
- **Owner recovery** (`POST /api/pipeline/runs/:id/recover`, `pipeline:recover`, owner only;
  `PipelineService.recoverRun`): on a `failed` or `missed` hourly run, under the pipeline lease and in
  the background. The current hour is crawled again; a past hour with a stored crawl is rescanned
  and re-exported from it; a past hour with nothing stored stays a gap (the source serves only
  current quotes) and recovery instead runs the current hour, or, if that is done, refreshes daily
  history for the latest batch's candidates and rescans it. It never sends Telegram or creates
  forward-test events for a past hour; the run keeps its status and gains `metrics.recovery`.
- **Bounded retries**: collect retries once; HTTP client bounded attempts with backoff; the daily
  stage stops on denial, rate limiting or five consecutive failures and resumes next run;
  Telegram up to 6 attempts on its own schedule (never re-runs collection or analysis).
- **Withholding** (PDF p.18): an INCOMPLETE batch or an unavailable LBank feed withholds the
  Review Queue (`WITHHELD_INCOMPLETE_BATCH`, `WITHHELD_LBANK_UNAVAILABLE`); its rows stay
  inspectable and the dashboard and Telegram say why.

## Telegram

One compact message per batch: batch time and status, counts (coins checked / ranked 1–1200 /
eligible), the Review Queue as a phone-width table (stars, 3d/7d/30d multiples with `*` for YES,
current VMC) with LBank pairs, and notes for withheld or empty queues. Synthetic data is labelled
TEST DATA. Wording is "for human review", never buy/sell. Reports are text only (the
workbook attachment was removed with the XLSX export on 2026-11-24; a workbook part still queued
from before fails permanently instead of being sent).

**Access.** The owner is `TELEGRAM_CHAT_ID`. Anyone else who messages the bot is held as
_pending_ and the owner is notified with `/approve <id>`, `/deny <id>`. Approved members receive
the hourly report (one `telegram_delivery` row per chat; a failing recipient never blocks the
others) and can use `/report`, `/status`, `/vmc <cmcId|symbol>` (short window summary),
`/coin <cmcId|symbol>` (status, current VMC, windows with multiple bars, VMC and price sparklines,
LBank pairs and mapping tasks, CMC Markets venues, the latest review, and the 30 completed daily
rows in an expandable quote; coin names in reports are `t.me/<bot>?start=coin_<id>` deep links, which arrive as
`/start coin_<id>`; `/coin_<id>` and `/vmc_<id>` are the fallback when the bot username is not
known yet), `/help`. Strangers who tap a forwarded link still meet the access gate. Only the
owner can `/run`, `/users`, `/approve`, `/deny`, `/remove`. Denied chats are ignored; groups
cannot request access. State lives in `app_state` key `telegram.access`
(`src/modules/telegram/access.service.ts`). Sharing reports with other people is the "redistribution"
decision in `intend.md`: confirm the data provider's terms.

## MCP vs dashboard boundary

- **Dashboard → REST** (`/api/*`) reading `ReadModelService`. The dashboard is a React + TypeScript app in
  `front/`, deployed as its own container (`web`, nginx) that proxies `/api` to the API on the same
  origin, or calls an API host allowed by `CORS_ORIGINS` ([ADR-0006](adr/0006-react-dashboard.md)). Responses are
  `{ data, errors }`; an error carries a stable `code` (`common/dto/error-codes.ts`) and every
  body, query and path parameter is validated with Zod (400 `VALIDATION_FAILED`). Every `/api`
  route needs a signed-in user (401 `AUTH_REQUIRED`) whose role has the route's permission (403
  `PERMISSION_DENIED`; `modules/auth/permissions.ts`); writes must also be same-origin JSON (403
  `WRITE_FORBIDDEN`). Export downloads are plain files; `GET /healthz` is a liveness probe outside
  `/api`.
- **External hosts → `/mcp`** (Streamable HTTP, stateless, bearer token, DNS-rebinding
  protection on loopback) or **stdio** (`npm run mcp:stdio`). Tools: `get_scan_summary`,
  `get_scan_results`, `get_asset_trace`, `list_batches`, `get_mapping_tasks`, `get_coverage`,
  `get_snapshots`, `list_assets`, `get_run_status`, `get_forward_test_summary`,
  `get_forward_events`, `get_forward_event`; resources `coins://tier1/queue/latest`,
  `coins://runs/latest`. There are no write tools.
- **Claude coin agent** (owners, `agent:use`): `GET` / `POST /api/assets/:cmcId/agent`. The run uses
  its own in-process, read-only tools bound to that coin; it is not exposed over MCP or Telegram
  ([ADR-0005](adr/0005-coin-agent.md)).
- **Live chart**: the coin details embed TradingView widgets as sandboxed, cross-origin iframes
  (CSP `frame-src https://www.tradingview-widget.com`; no third-party script runs in the
  dashboard). Their data reaches only the viewer's browser and is never stored.
- PostgreSQL is the single source of truth for all three.

## CMC website collection

One shared `CmcWebClient` (sequential queue, `PoliteHttpClient`) serves four whitelisted routes on
`https://api.coinmarketcap.com` (website JSON endpoints, not the supported Pro API contract):

| Route                                             | Use                                                                                                                                                                                                     | Parameters                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/data-api/v3/cryptocurrency/listing`             | Hourly listing of every coin: price, circulating cap, rolling-24h volume, rank, date added, tags, slug, platform                                                                                        | `limit=10000`, `convertId=2781`, sorted by market cap                                                                                                                             |
| `/data-api/v3.1/cryptocurrency/historical`        | Completed UTC daily rows: that day's volume and the market cap at the day's close                                                                                                                       | `id`, `convertId=2781`, `timeStart`/`timeEnd` (seconds), `interval=1d`                                                                                                            |
| `/data-api/v3/exchange/market-pairs/latest`       | LBank Spot pairs mapped by CMC base-asset id (no trading status) — the data behind the Markets section of `coinmarketcap.com/exchanges/lbank/?type=spot`; fetched once, then every 30 days or on demand | `slug=lbank`, `category=spot`, pages of 500 overlapping by 50 rows (the list is volume-ordered and moves between requests), deduplicated by CMC market id, until `numMarketPairs` |
| `/data-api/v3/cryptocurrency/market-pairs/latest` | Asset spot venues (top 100 by CMC rank) for venue flags                                                                                                                                                 | `slug`, `category=spot`, `limit=100`                                                                                                                                              |

Verified behaviour (2026-11-03 / 2026-11-05): the whole ~8k listing arrives in one request
(multi-page sweeps sorted by cap are unstable among thousands of coins tied at zero cap, so they
are a fallback reported as partial); `interval=3d` fails with application error 500 inside HTTP
200 while `interval=1d` works; history responses can include dates outside the requested window,
so the collector filters to completed UTC days in range and skips the open day; HTML challenge
pages are treated as 403 denials. Defaults: 30 requests/minute strictly sequential, two retries,
60-second bounded cache, Retry-After honoured, cooldown / budget / circuit state persisted in
`source_health`, suspension after repeated denials until `npm run cli -- source:reset --provider
coinmarketcap_web`. No proxy or identity rotation, no CAPTCHA handling; "no bans" is not promised.

## Retired components (2026-11-05)

The Two-Tier VMC handoff replaced the earlier system; conflicts and decisions are listed in
[strategy-two-tier-vmc.md § Conflicts](strategy-two-tier-vmc.md). Removed: the momentum "surge
screen" (features, heuristic scores, pump chance), the Claude Agent SDK review (coordinator,
analyst, risk reviewer, runtime skills), signals, paper trading, outcome labelling and backtests,
the separate six-month Volume / Market Cap baseline module (`src/vmc/`, 72 h chart backfill), and
the seven-day chart history stage. Their code and documents remain in git history (last commit
before removal: `1d81a87`, e.g. `git show 1d81a87:docs/strategy-limitations.md`); the database
rows they produced are in the pre-migration backup described in
[implementation-plan.md § Database preparation](implementation-plan.md).

On 2026-11-12 a narrower agent returned ([ADR-0005](adr/0005-coin-agent.md)). It runs for one
coin only when an owner asks, with read-only tools, no scores or signals in the pipeline, and a
limit of 5 runs per 12 hours. The multi-agent signal review above stays retired.

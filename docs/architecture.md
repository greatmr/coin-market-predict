# Architecture

The system implements the **Two-Tier VMC strategy** ([strategy-two-tier-vmc.md](strategy-two-tier-vmc.md)):
an hourly, deterministic Tier 1 screen over CoinMarketCap data, and a Tier 2 human chart review
with an optional manual LBank Spot trade plan. No component places orders, ranks by predicted
return, or calls an LLM.

## Overview
```
                 ┌───────────────────── NestJS application (one process) ─────────────────────┐
 cron (UTC) ───▶ │ PipelineService (DB lease + PipelineStage records), one run per UTC hour      │
                 │  discover ─ collect ─ lbank ─ daily ─ scan ─ venues ─ export ─ notify          │
                 │     │  MarketDataSource (listing)    Tier1Source (daily rows, LBank / asset    │
                 │     │  fixture | CMC website | CMC API | CoinGecko      market pairs)          │
                 │  ScanService: eligibility → VMC windows → pass/stars → queue  (pure tier1/*.ts)│
                 │  ExportService: CSV per sheet + XLSX workbook + manifest (sha256)              │
                 │  ReviewService: append-only Tier 1 / Tier 2 review records, LBank decisions    │
                 │                                                                                │
                 │ REST /api/* ─▶ dashboard (public/)   MCP /mcp + stdio (read-only)   Telegram   │
                 └──────────────────────────────────────┬─────────────────────────────────────────┘
                                                        ▼
                                              PostgreSQL (source of truth)
```

## Modules (`src/`)
| Module | Responsibility |
|---|---|
| `config/` | Zod-validated env, `*_FILE` secrets, redaction |
| `common/` | Exact decimal helpers (80 significant digits), UTC date helpers, CSV and dependency-free XLSX writers |
| `sources/` | `MarketDataSource` (hourly listing) and `Tier1Source` (daily history, LBank Spot pairs, asset market pairs) adapters: synthetic fixture, CMC website, CMC Basic API, CoinGecko; polite HTTP client with persisted budgets and circuit state |
| `ingestion/` | Discovery (identity, contracts, delisting on complete sweeps), hourly collection, validation, coverage, `CrawlBatch` record (rank continuity), `CmcAsset` metadata with change log, heuristic classification |
| `tier1/` | Strategy rules (`constants.ts`), eligibility, VMC arithmetic, LBank resolution, venue summary, queue ordering, review rules — all pure and unit-tested; services for daily rows, venue crawls, scans, exports and reviews |
| `telegram/` | Hourly summary formatting and delivery (dedupe, retries), bot commands, access control |
| `pipeline/` | Orchestrator, DB lease, scheduler, restart recovery, storage retention |
| `read-model/` | Read-only queries shared by dashboard, MCP and Telegram (sheets, calculation traces, batches, exports) |
| `dashboard/` | REST API, Basic auth, security headers, review / decision endpoints |
| `mcp/` | Read-only MCP tools over HTTP (bearer token) and stdio |

## Pipeline stages
| Stage | What it does | On failure |
|---|---|---|
| `discover` | Listing sweep when due (`DISCOVERY_INTERVAL_HOURS`): identities, contracts, classes | logged; collection continues |
| `collect` | One validated snapshot per listed coin for the UTC hour (website: one `limit=10000` request); records the `CrawlBatch` (COMPLETE only if every listed coin was stored and ranks 1–1200 are contiguous and unique) and syncs `CmcAsset` metadata | retried once, then a FAILED batch is recorded and the run fails |
| `lbank` | Reuses the stored LBank Spot markets list until it is `LBANK_PAIRS_REFRESH_DAYS` (30) old, then fetches it again; records `LISTED`/`ABSENT` pair events on each complete fetch. Manual refresh: dashboard / `lbank:refresh` | non-fatal: a failed refresh keeps the previous list until `LBANK_PAIRS_MAX_AGE_DAYS` (35); without a usable list every LBank status is UNKNOWN and the queue is withheld |
| `daily` | Refreshes completed UTC daily rows (`TIER1_DAILY_LOOKBACK_DAYS`) for screen candidates lacking T−1, once per UTC day, bounded by assets / minutes / request budget | non-fatal: missing days make only the affected windows N/A |
| `scan` | Deterministic Tier 1 evaluation of every coin in the batch; writes `ScanRun` + `ScanResult` rows, queue order, warnings, LBank mapping tasks | fatal (the run fails; the previous scan stays the latest valid one) |
| `venues` | CMC Markets venue rows for review candidates (≤ `TIER1_VENUE_MAX_ASSETS_PER_RUN`, refreshed every `TIER1_VENUE_REFRESH_HOURS`) | non-fatal: rows show `VENUE_DATA_PENDING` |
| `export` | CSV per sheet + XLSX workbook + manifest into `TIER1_EXPORT_DIR`; written to a temp directory and renamed only on success | non-fatal: the previous export remains the latest valid file |
| `notify` | Telegram summary of the batch (dry run by default); retention runs afterwards | Telegram retries on its own 5-minute schedule |

A run whose non-fatal stages degraded finishes `partial` with the reasons in
`PipelineRun.metrics.degraded`. Each stage logs `[███░░░░░] n/8 stage · done in Xs`;
`PipelineRun.currentStage` and `PipelineStage` rows drive the dashboard step bar.
`npm run cli -- tier1:scan --batch <id>` (or the dashboard's *Reprocess latest batch*) recomputes
a stored batch from saved data under the same lease, without crawling.

## Data model (Prisma)
Kept: `Provider`, `Asset`, `AssetIdentity`, `AssetContract`, `DiscoveryRun`, `SourceHealth`,
`MarketSnapshot` (now with `rank`, `dateAdded`, `tags`), `PipelineRun` + `PipelineStage`,
`JobLease`, `AppState`, `TelegramDelivery`.

Tier 1 (migration `20261105070000_two_tier_vmc_strategy`):
| Table | Purpose |
|---|---|
| `CmcAsset`, `CmcAssetChange` | CMC-id-keyed metadata (symbol, name, slug, tags, date added, platform) and every change to it |
| `CrawlBatch` | One per provider + UTC hour: crawl time, status + reasons, listed / collected counts, missing and duplicate ranks |
| `DailyMetric`, `DailyMetricRevision`, `DailyFetchState` | Effective completed-day row per coin and date, every revision with source route, parameters and response SHA-256, per-coin fetch state |
| `VenueCrawl`, `VenuePairEvent` | LBank pair feed / asset market-pair crawls (raw pairs as JSON) and LBank listing / absence events |
| `VenueDecision`, `VenueMappingTask` | Reviewer decisions (mapping confirmed / rejected, verified tradable, not tradable) and open ambiguous-ticker tasks |
| `ScanRun`, `ScanResult` | One scan per batch (queue status, counts, warnings, export state) and one row per coin with every value, status, reason, the daily window used, inputs hash, ruleset and config versions |
| `Review` | Append-only Tier 1 / Tier 2 review revisions with the Tier 1 snapshot they were made against |

Money and ratio columns are `Decimal(65,30)`; timestamps `timestamptz`; all storage is UTC.

## Determinism and traceability
- Every ratio is computed from stored source values with exact decimal arithmetic; a pass is
  `current ≥ 1.5 × mean`, evaluated without rounding (exactly 1.5× is YES).
- `ScanResult` stores the inputs hash, `RULESET_VERSION`, the configuration version (rules +
  override file hash), the daily revision ids used, and the scan time; re-running a scan over
  unchanged inputs reproduces the same rows.
- The as-of time of a scan is the batch's crawl time, so a replay never uses rows that appeared
  later (A1). Daily rows revised after a scan are shown as "revised since" in the trace.
- `GET /api/assets/:cmcId/trace` (dashboard drawer, `tier1:trace`, MCP `get_asset_trace`) prints
  each window's dates, values and formula, e.g. `mean_3d = (0.1 + 0.1 + 0.1) / 3 = 0.1`.

## Storage and retention
Every listed coin (~8k on the website) gets one `MarketSnapshot` and one `ScanResult` per UTC
hour; daily rows exist only for screen candidates. Rules (`src/pipeline/retention.service.ts`):
- After `RETENTION_DETAIL_DAYS` (default 30), snapshots of coins outside the Tier 1 band (rank
  101–1200, or unranked with cap ≥ $15M, ±72 h) keep the first snapshot of each UTC day — a
  genuine observation, never an aggregate — and `ScanResult` rows excluded only by rank or cap
  keep the first batch of each UTC day. Reprocessing a thinned old batch therefore lists fewer
  Excluded rows; band coins are unaffected.
- Export files older than `EXPORT_RETENTION_DAYS` (default 7) are deleted; the database keeps
  every result, so an export can be regenerated with `tier1:export --batch <id>`.
- `RETENTION_SNAPSHOT_DAYS > 0` deletes older snapshots outright (default 0 keeps everything).
- Reviews, decisions, daily rows, crawl batches and runs are never pruned.

## Reliability
- **Non-overlap**: in-process flag + `JobLease` (atomic upsert using DB time, heartbeat). Scans,
  reprocessing and exports run under the same lease.
- **Idempotency**: unique keys + `skipDuplicates`/`upsert`; daily rows only gain a revision when
  normalized values change; a scan replaces its own rows in one transaction.
- **Restart recovery**: completed stages are skipped on resume; missed hours are recorded as
  `missed` and never backfilled from a live source; the current hour runs on startup when
  `MISSED_RUN_POLICY=current_slot`.
- **Bounded retries**: collect retries once; HTTP client bounded attempts with backoff; the daily
  stage stops on denial, rate limiting or five consecutive failures and resumes next run;
  Telegram up to 6 attempts on its own schedule (never re-runs collection or analysis).
- **Withholding** (PDF p.18): an INCOMPLETE batch or an unavailable LBank feed withholds the
  Review Queue (`WITHHELD_INCOMPLETE_BATCH`, `WITHHELD_LBANK_UNAVAILABLE`); the sheets stay
  inspectable and the dashboard and Telegram say why.

## Telegram
One compact message per batch: batch time and status, counts (eligible / needs review /
excluded), the Review Queue as a phone-width table (stars, 3d/7d/30d multiples with `*` for YES,
current VMC) with LBank pairs, and notes for withheld or empty queues. Synthetic data is labelled
TEST DATA. Wording is "for human review", never buy/sell. With `TELEGRAM_ATTACH_EXPORT=xlsx`
(default) the batch's `workbook.xlsx` follows as a document (`sendDocument`, named
`coins-tier1_<slot>Z.xlsx`); it is a final report part, so it is sent only after the text, retried
and deduplicated per recipient like the text, and skipped when the queue is withheld or the
export failed or was pruned.

**Access.** The owner is `TELEGRAM_CHAT_ID`. Anyone else who messages the bot is held as
*pending* and the owner is notified with `/approve <id>`, `/deny <id>`. Approved members receive
the hourly report (one `TelegramDelivery` row per chat; a failing recipient never blocks the
others) and can use `/report`, `/status`, `/vmc <cmcId|symbol>` (short window summary),
`/coin <cmcId|symbol>` (the dashboard drawer: status, current VMC, windows, the 30 completed daily
rows, LBank pairs and mapping tasks, CMC Markets venues, reviews — split into phone-width
messages), `/help`. Only the
owner can `/run`, `/users`, `/approve`, `/deny`, `/remove`. Denied chats are ignored; groups
cannot request access. State lives in `AppState` key `telegram.access`
(`src/telegram/access.service.ts`). Sharing reports with other people is the "redistribution"
decision in `intend.md`: confirm the data provider's terms.

## MCP vs dashboard boundary
- **Dashboard → REST** (`/api/*`) reading `ReadModelService`; review and LBank decision writes
  are accepted only on a loopback bind or with `DASHBOARD_BASIC_AUTH`.
- **External hosts → `/mcp`** (Streamable HTTP, stateless, bearer token, DNS-rebinding
  protection on loopback) or **stdio** (`npm run mcp:stdio`). Tools: `get_scan_summary`,
  `get_scan_results`, `get_asset_trace`, `list_batches`, `get_mapping_tasks`, `get_coverage`,
  `get_snapshots`, `list_assets`, `get_run_status`; resources `coins://tier1/queue/latest`,
  `coins://runs/latest`. There are no write tools.
- PostgreSQL is the single source of truth for all three.

## CMC website collection
One shared `CmcWebClient` (sequential queue, `PoliteHttpClient`) serves four whitelisted routes on
`https://api.coinmarketcap.com` (website JSON endpoints, not the supported Pro API contract):

| Route | Use | Parameters |
|---|---|---|
| `/data-api/v3/cryptocurrency/listing` | Hourly listing of every coin: price, circulating cap, rolling-24h volume, rank, date added, tags, slug, platform | `limit=10000`, `convertId=2781`, sorted by market cap |
| `/data-api/v3.1/cryptocurrency/historical` | Completed UTC daily rows: that day's volume and the market cap at the day's close | `id`, `convertId=2781`, `timeStart`/`timeEnd` (seconds), `interval=1d` |
| `/data-api/v3/exchange/market-pairs/latest` | LBank Spot pairs mapped by CMC base-asset id (no trading status) — the data behind the Markets section of `coinmarketcap.com/exchanges/lbank/?type=spot`; fetched once, then every 30 days or on demand | `slug=lbank`, `category=spot`, pages of 500 overlapping by 50 rows (the list is volume-ordered and moves between requests), deduplicated by CMC market id, until `numMarketPairs` |
| `/data-api/v3/cryptocurrency/market-pairs/latest` | Asset spot venues (top 100 by CMC rank) for venue flags | `slug`, `category=spot`, `limit=100` |

Verified behaviour (2026-11-03 / 2026-11-05): the whole ~8k listing arrives in one request
(multi-page sweeps sorted by cap are unstable among thousands of coins tied at zero cap, so they
are a fallback reported as partial); `interval=3d` fails with application error 500 inside HTTP
200 while `interval=1d` works; history responses can include dates outside the requested window,
so the collector filters to completed UTC days in range and skips the open day; HTML challenge
pages are treated as 403 denials. Defaults: 30 requests/minute strictly sequential, two retries,
60-second bounded cache, Retry-After honoured, cooldown / budget / circuit state persisted in
`SourceHealth`, suspension after repeated denials until `npm run cli -- source:reset --provider
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

# Two-Tier VMC Strategy — implementation plan

> **Historical record.** This plan and its § 7 database procedure were written for and executed on
> the Prisma schema (2026-11-05); its table names and `prisma` commands describe that time. Since
> 2026-11-06 the persistence layer is TypeORM ([ADR-0001](adr/0001-typeorm-modular-layout.md)):
> current migration, cut-over and recovery commands are in
> [operator-guide § 9](operator-guide.md#9-backup-restore-and-migrations).

Plan written before any behaviour change (2026-11-05). Strategy: [strategy-two-tier-vmc.md](strategy-two-tier-vmc.md).
Inputs and gaps: [tier1-input-mapping.md](tier1-input-mapping.md). Assumption ids (A1…) refer to
the strategy document §9; conflict ids (C1…) to §10; gap ids (G1…) to the input mapping.

## 1. Target flow (hourly pipeline)

| Stage | Responsibility | New / changed | PDF |
|---|---|---|---|
| `discover` | Listing sweep when due (unchanged) | — | — |
| `collect` | Existing crawler batch; parser keeps `cmcRank`, `dateAdded`, raw tags; writes `CrawlBatch` (completeness, field counts, rank continuity) and `CmcAsset` (+ change log) | changed (G1–G3, G8) | p.8, p.10, p.16 |
| `lbank` | LBank Spot pairs from CMC's LBank markets data via the shared website client; `VenueCrawl` + listing events | new (G6) | p.10 |
| `daily` | Completed UTC daily rows for screen candidates lacking T−1 (35-day window, bounded, budget reserve) → `DailyMetricRevision` / `DailyMetric` | reused route, new scope (G4, G5) | p.5, p.11 |
| `scan` | Deterministic Tier 1 evaluation for every asset of the batch → `ScanResult` upsert per (batch, CMC id); `ScanRun` counts, warnings, queue status | new | p.9–14, p.18 |
| `venues` | CMC Markets spot pairs for review candidates (≤ daily per asset) → venue flags on the batch's scan rows | new (G7) | p.15 |
| `export` | CSV per sheet + XLSX workbook + manifest with SHA-256; previous export stays current on failure | new | p.17, p.18 |
| `notify` | Telegram Review Queue summary (dry run unless live; withheld queue → reason only) | changed (C6) | p.18 |
| retention | Snapshot thinning by Tier 1 band; thin rank/cap-only excluded scan rows; prune old export files | changed (A20) | — |

Removed stages: `history` (72 h chart backfill, C5), `features`, `screen`, `vmc` (six-month baseline,
C1), `analyze` (agents, C2), `publish` (signals/paper trading, C2).

Overlap: the existing in-process flag + `JobLease` keep one pipeline run at a time across instances.
Idempotency: snapshots first-write-wins; daily revisions only on content change; scan results upsert
on (batch, CMC id); reviews and venue decisions are append-only; exports are per batch.

## 2. Requirement → component map

| Requirement (page) | Code | Data | API / UI | Tests |
|---|---|---|---|---|
| CMC id identity, symbol changes (p.4, p.10) | `ingestion.service.ts` (CmcAsset upsert) | `CmcAsset`, `CmcAssetChange` | asset trace | db: symbol change keeps one asset |
| Field mapping + gaps (p.8) | parser fix `coinmarketcap-web/parse.ts` | `MarketSnapshot.rank/dateAdded/tags` | — | unit: listing parse keeps rank/date/tags |
| Eligibility (p.3, p.9) | `tier1/eligibility.ts` `evaluateEligibility`, `classify` | `ScanResult.eligibility*` | sheets | unit: F boundaries, classes, overrides |
| Class overrides (p.9) | `tier1/overrides.ts` | `config/tier1-overrides.json` (versioned) | config view | unit: override wins, version recorded |
| LBank status (p.10) | `tier1/lbank.ts` + `tier1/venues.service.ts` | `VenueCrawl`, `VenuePairEvent`, `VenueDecision`, `VenueMappingTask` | LBank panel, decisions | unit: statuses; db: disappearance, verification voided |
| Daily rows (p.5, p.11) | `tier1/daily.service.ts` | `DailyMetricRevision`, `DailyMetric`, `DailyFetchState` | 30-day trace table | unit: parser; db: revision upsert, no duplicates |
| VMC arithmetic (p.13) | `tier1/vmc.ts` (exact decimals) | `ScanResult` means/multiples | trace formulas | unit: A, B, C, D, E |
| Current observation (p.12) | `tier1/vmc.ts` `currentObservation` | `ScanResult.currentStatus` | current panel | unit: stale, missing time, mismatched, invalid |
| Stars, sort, queue (p.14) | `tier1/queue.ts` `compareQueue`, `inReviewQueue` | `ScanResult.inQueue/queueOrder` | Review Queue | unit: sort keys incl. N/A after NO |
| Venue concentration (p.15) | `tier1/venues.ts` flags | `VenueCrawl` (asset markets) | venue panel | unit: Upbit top, single venue, pending |
| Exports (p.17) | `tier1/export.service.ts`, `common/csv.ts`, `common/xlsx.ts` | `ScanRun.export*`, files under `var/exports/<provider>/<slot>Z_<batch>[_SYNTHETIC]/` | Exports tab, download | unit: columns, N/A blank, zip/xlsx structure |
| Observability (p.18) | `ScanRun.counts/warnings` | `ScanRun` | Overview, Batches | db: incomplete batch withholds queue |
| Reviews Tier 1 + Tier 2 (p.15, p.24–27) | `tier1/review-rules.ts`, `tier1/review.service.ts` | `Review` (append-only revisions, Tier 1 snapshot) | asset drawer forms | unit: plan validation, deadline; db: revisions preserved |
| Demonstration (p.20) | fixture market `sources/fixture/fixture-cmc.ts` | synthetic batch | CLI `tier1:trace`, dashboard | db: end-to-end demo cases, replay idempotency |

## 3. Data model changes (one versioned migration)

New tables: `CmcAsset`, `CmcAssetChange`, `CrawlBatch`, `DailyMetric`, `DailyMetricRevision`,
`DailyFetchState`, `VenueCrawl`, `VenuePairEvent`, `VenueDecision`, `VenueMappingTask`, `ScanRun`,
`ScanResult`, `Review`. Every table carries `providerId`, so synthetic fixture data and live CMC data
never mix. Money columns are `Decimal`; ratios use `numeric(65,30)`; times are `timestamptz`.

Changed: `MarketSnapshot` + `rank`, `dateAdded`, `tags` (nullable, so earlier rows stay valid);
`PipelineRun` loses relations to retired tables and `modelCostUsd`.

Dropped (legacy, emptied first): `FeatureSetVersion`, `StrategyVersion`, `FeatureValue`,
`ScreeningResult`, `Signal`, `AgentExecution`, `PaperPosition`, `SignalOutcome`, `BacktestReport`,
`VmcAsset`, `VmcAssetMetadataChange`, `VmcRun`, `VmcAssetResult`, `VmcRawResponse`,
`VmcDailyObservation`, `VmcDailyCurrent`, `VmcHourlySnapshot`, `VmcHourlyCurrent`, `VmcBaseline`,
`VmcBaselineMember`.

Kept unchanged: `Provider`, `Asset`, `AssetIdentity`, `AssetContract`, `DiscoveryRun`,
`SourceHealth`, `PipelineStage`, `AppState`, `JobLease`, `TelegramDelivery`.

## 4. Data semantics

| Concept | Definition |
|---|---|
| Coin identity | (`providerId`, CMC numeric id). Symbols/names/slugs are metadata with a change log; venue rows join by CMC `baseCurrencyId` |
| Crawl batch | One `CrawlBatch` per (provider, UTC hour slot); `crawledAt` is the batch's as-of time (A1) |
| Provider update time | Listing `quotes[USD].lastUpdated` → `observedAt` |
| Quote currency | USD only (`convertId=2781`); every money value is USD |
| Current volume | CMC rolling 24 h volume at `observedAt` — never hourly volume, never derived |
| Market cap | CMC circulating cap; null/0 = missing (FDV never used; a cap calculated from supply is treated as not provider-reported) |
| Daily row | One completed UTC day: volume of that day, cap at that day's close, close timestamp; open day never stored |
| Missing values | NULL plus a reason code; never 0, never forward-filled |
| Freshness | quote age = `collectedAt − observedAt`; stale beyond `MAX_QUOTE_AGE_MINUTES` (2 × 60) |
| Historical coverage | Windows need every date T−1…T−N valid; coverage shown per window with dates and revision ids |

## 5. Configuration

Added: `CRAWL_EXPECTED_INTERVAL_MINUTES` (60), `MAX_QUOTE_AGE_MINUTES` (default 2 × interval),
`TIER1_DAILY_LOOKBACK_DAYS` (35), `TIER1_DAILY_MAX_ASSETS_PER_RUN` (1500),
`TIER1_DAILY_MAX_MINUTES` (30), `TIER1_DAILY_RETRY_HOURS` (3), `TIER1_VENUE_REFRESH_HOURS` (24),
`TIER1_VENUE_MAX_ASSETS_PER_RUN` (60), `TIER1_OVERRIDES_FILE`, `TIER1_EXPORT_DIR`,
`EXPORT_RETENTION_DAYS` (7), `TELEGRAM_QUEUE_ROWS` (10). Default
`CMC_WEB_MONTHLY_REQUEST_BUDGET` raised to 30,000 (≈ 24 listings + 48 LBank pages + one daily
request per candidate + venue refreshes per day; a reserve always keeps hourly listings running).

Removed: `MIN_MARKET_CAP_USD`, `MIN_VOLUME_24H_USD`, `SNAPSHOT_WINDOW`, `STALE_AFTER_MINUTES`,
`SHORTLIST_SIZE`, `RECOMMENDATIONS_MAX`, `CANDIDATE_MIN_HISTORY`, `SOURCE_HISTORY_BOOTSTRAP_*`,
`AGENT_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `PAPER_*`, `VMC_*`. Unknown variables left in an existing
`.env` are ignored.

## 6. Interfaces

- REST (`/api`): `overview`, `config`, `scan?sheet=queue|eligible|needs_review|excluded|all`,
  `assets`, `assets/:cmcId/trace`, `assets/:cmcId/snapshots`, `batches`, `health`, `runs`,
  `deliveries`, `mapping-tasks`, `exports`, `exports/:batchId/:file`, `reviews` (GET/POST),
  `reviews/:id/export`, `venue-decisions` (POST), `scan/rescan` (POST), Telegram access (kept).
  Writes require JSON, same origin and loopback or Basic auth (existing guard).
- MCP (read only): `get_coverage`, `list_batches`, `get_scan_summary`, `get_scan_results`,
  `get_asset_trace`, `get_mapping_tasks`, `get_snapshots`, `list_assets`, `get_run_status`
  (implemented `get_mapping_tasks` instead of the planned `get_reviews`: reviews are visible in
  `get_asset_trace`, and open mapping tasks were the missing read path).
- CLI: `run-once`, `discover`, `tier1:scan [--batch ID]` (dry run over saved data, p.18),
  `tier1:export [--batch ID]`, `tier1:trace --id N [--batch ID]`, `tier1:batches`,
  `daily:import-csv`, `telegram:*`, `source:reset`, `config:check`.
- Dashboard tabs: Overview, Review Queue, All Eligible, Needs Review, Excluded, Batches & health,
  Exports, Telegram access; asset drawer with the full calculation trace, LBank pairs and
  decisions, venue rows, review history and the Tier 1 / Tier 2 review form.

## 7. Database preparation (before the schema migration)

1. **Backup**: `pg_dump -Fc` of database `coins` to `backups/` (git-ignored), SHA-256 recorded.
2. **Verify**: `pg_restore --list`, then a full restore into a scratch database
   `coins_restore_check` and a row-count comparison of every table; scratch database dropped after.
3. **Clear** (one transaction, explicit `DELETE` per table, children first, no `TRUNCATE … CASCADE`;
   foreign keys are `RESTRICT`, so a missed dependent aborts the transaction):

   | Order | Tables cleared | Why coin-related |
   |---|---|---|
   | 1 | `VmcBaselineMember`, `VmcBaseline`, `VmcAssetResult`, `VmcRawResponse`, `VmcRun`, `VmcDailyCurrent`, `VmcDailyObservation`, `VmcHourlyCurrent`, `VmcHourlySnapshot`, `VmcAssetMetadataChange`, `VmcAsset` | six-month VMC observations and results |
   | 2 | `PaperPosition`, `SignalOutcome`, `Signal`, `AgentExecution`, `ScreeningResult`, `FeatureValue`, `BacktestReport`, `StrategyVersion`, `FeatureSetVersion` | predictions, features, research results |
   | 3 | `TelegramDelivery`, `PipelineStage`, `PipelineRun`, `DiscoveryRun` | coin report deliveries and run records |
   | 4 | `MarketSnapshot` | coin observations |
   | 5 | `AssetContract`, `AssetIdentity`, `Asset` | coin identities (rebuilt by the next discovery) |
   | 6 | `AppState` keys `vmc.capabilities`, `fixture.anchorSlot` | state of the removed VMC module and old fixture market |

   **Preserved**: `Provider` (source registry), `SourceHealth` (request budget and circuit state),
   `JobLease`, `AppState` keys `telegram.access` (owner-approved members — permissions) and
   `telegram.updateOffset` (bot state), `_prisma_migrations`. No users/credentials live in other
   tables; secrets stay in `.env`/`secrets/`.
4. **Verify**: cleared tables are empty; preserved rows byte-identical (row counts and MD5 of the
   rows taken before and after).
5. **Migrate**: generate SQL with `prisma migrate diff --from-config-datasource --to-schema …`,
   review it, save as a new migration folder, apply with `prisma migrate deploy` (never `db push`,
   never `migrate reset`). Re-verify the preserved rows and `prisma migrate status`.

### 7a. As executed (2026-11-05, UTC)
- **Backup**: `backups/coins-pre-two-tier-vmc-2026-11-05.dump` (`pg_dump -Fc`, 17.6 MB),
  SHA-256 `b132d7b6f7697a1e882c216b82319f8fc22cdc585dc19b4f317cace48e64073b`.
- **Restore check** (06:49): full restore into `coins_restore_check` exited 0; row counts of all
  33 tables identical to the source, and MD5 fingerprints identical for `Provider`,
  `SourceHealth`, `AppState`, `MarketSnapshot` and `_prisma_migrations`; scratch database dropped.
- **Clear** (`scripts/db/2026-11-05-clear-coin-data.sql`): rehearsed in a transaction ending in
  `ROLLBACK` (06:50; counts unchanged afterwards), then committed (06:51). The script's own
  assertions confirmed every cleared table empty and the preserved fingerprints unchanged.
  Rows removed (the backup's counts; no writes occurred between backup and clear):

  | Group | Rows |
  |---|---|
  | VMC module | `VmcBaselineMember` 9,857 · `VmcDailyCurrent` 9,857 · `VmcDailyObservation` 9,857 · `VmcAssetResult` 330 · `VmcHourlySnapshot` 316 · `VmcHourlyCurrent` 291 · `VmcRawResponse` 186 · `VmcRun` 82 · `VmcBaseline` 65 · `VmcAsset` 62 · `VmcAssetMetadataChange` 0 |
  | Predictions / research | `FeatureValue` 11,240 · `ScreeningResult` 10,375 · `Signal` 56 · `SignalOutcome` 43 · `AgentExecution` 40 · `StrategyVersion` 2 · `BacktestReport` 2 · `FeatureSetVersion` 1 · `PaperPosition` 0 |
  | Runs and deliveries | `PipelineStage` 145 · `PipelineRun` 34 · `TelegramDelivery` 26 · `DiscoveryRun` 6 |
  | Observations and identities | `MarketSnapshot` 144,617 · `AssetIdentity` 8,070 · `Asset` 8,069 · `AssetContract` 1,724 |
  | App state | `AppState` keys `vmc.capabilities`, `fixture.anchorSlot` (2) |

- **Preserved** (fingerprints identical before the clear, after it, and after the migration):
  `Provider` 2 rows (`26e4f71c721a4b298f2e1dd7a692e91f`), `SourceHealth` 1
  (`dc298cf786f228343377a6384bea390c`), `AppState` `telegram.access` + `telegram.updateOffset`
  (`27c108b090bed707f59f41cd6a86d20d`), `JobLease` 0, `_prisma_migrations` 3 (+1 new entry).
- **Migration**: `prisma/migrations/20261105070000_two_tier_vmc_strategy` applied with
  `prisma migrate deploy`; `prisma migrate status` reports the schema up to date.

## 8. Acceptance criteria

1. Unit tests cover PDF p.19 A–F exactly (status, reason code, stars, sort order) on unrounded values.
2. A fixture run produces a batch where one asset is YES/NO/YES and one is 0-star, an ambiguous
   LBank ticker is held in Needs Review with a mapping task, a missing daily row yields N/A for the
   windows containing it, and an LBank pair is verified from the feed (p.20).
3. Replaying the same batch leaves snapshot, scan-result and review counts unchanged (p.20 #5).
4. Exports contain the five sheets and every mandatory column; N/A numerics are blank with a reason.
5. An incomplete batch or unavailable LBank feed withholds the queue (Telegram) and is bannered (UI).
6. Reviews and trade plans are append-only; validation rejects stop/target ordering errors and keeps
   incomplete plans INCOMPLETE; the deadline is entry + 7 × 24 h.
7. `npm run typecheck`, `npm run build`, `npm test`, `npm run test:db` pass; one live batch processed
   end to end with Telegram in dry-run mode; API and dashboard checked against it.

## 9. Recovery

- **Data**: `docker compose exec -T postgres pg_restore -U coins -d coins --clean --if-exists < backups/<dump>`
  restores every table to its pre-change state (run against a stopped app). To inspect without
  touching live data, restore into a new database (`createdb coins_restore && pg_restore -d coins_restore …`).
- **Code**: the previous implementation is commit `1d81a87` on `develop`; checking it out together
  with the restored dump returns the system to its pre-change behaviour (its migrations end at
  `20261103203211_recommendations`; the restored dump contains the matching `_prisma_migrations`).
- **Partial failure during migration**: `prisma migrate deploy` runs the migration in one
  transaction where PostgreSQL allows; if it fails, fix the SQL, mark it rolled back with
  `prisma migrate resolve --rolled-back <name>` and deploy again.

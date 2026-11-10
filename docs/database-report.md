# Database report: crawl storage, history and retention

Snapshot of the live database (`coins`, provider `coinmarketcap_web`) taken 2026-11-06 after the
08:00 UTC slot, about 23 hours after live crawling started (first slot 2026-11-05 10:00 UTC).
All figures come from read-only queries; nothing was changed. Retention code:
`src/modules/pipeline/retention.service.ts`.

> **Schema since 2026-11-06.** This snapshot was taken on the Prisma schema, whose quoted
> CamelCase table names are kept below as measured. The TypeORM schema that replaced it
> ([ADR-0001](adr/0001-typeorm-modular-layout.md)) has the same tables, columns, keys and numeric
> precision under snake_case names (`MarketSnapshot` → `market_snapshot`, `providerId` →
> `provider_id`, …), so the structure, retention rules and findings still apply; the figures
> describe the database before the cut-over.

## Summary

- The structure is sound. Raw observations and computed results are kept apart, a replayed
  hour neither duplicates nor overwrites stored data, history is append-only where it matters
  (daily revisions, metadata changes, reviews, decisions), and every result keeps lineage to the
  inputs it used.
- The concern is growth: 418 MB after 23 hourly slots, about **370 MB per day**. The rule that
  thins old scan rows matches almost no rows, so `ScanResult` alone would keep growing by about
  **65 GB per year** after the 30-day detail window (see [Finding 1](#1-scan-row-thinning-barely-applies)).

## Data flow per hourly run

```
discover (every 24 h) ─► Asset / AssetIdentity / AssetContract / CmcAsset   who exists
collect  (hourly)     ─► MarketSnapshot   one row per coin per hour (~8,023 rows)
                      ─► CrawlBatch       one row per hour: COMPLETE / INCOMPLETE, counts, missing ranks
                      ─► CmcAssetChange   only when symbol / name / slug / tags / dateAdded / contract change
lbank    (30 days)    ─► VenueCrawl (lbank_spot_pairs) + VenuePairEvent (LISTED / ABSENT)
daily    (hourly)     ─► DailyMetricRevision (every version) → DailyMetric (current version)
                         DailyFetchState (when to retry a missing day)
scan                  ─► ScanRun (one per batch) + ScanResult (one per coin per batch)
venues                ─► VenueCrawl (asset_markets, one per review candidate)
export / notify       ─► CSV + XLSX files on disk, TelegramDelivery
human review          ─► Review, VenueDecision (append-only)
run bookkeeping       ─► PipelineRun, PipelineStage, JobLease, SourceHealth, AppState
```

## How each kind of data is stored

### Hourly observations — `MarketSnapshot`

- One row per coin per UTC hour, unique on `(providerId, providerAssetId, slotTime, quoteCurrency)`.
  Writes use `INSERT … ON CONFLICT DO NOTHING`: the first write wins, so a replayed or resumed
  hour adds nothing and never overwrites an observation.
- Three times are kept apart: `slotTime` (hour bucket), `collectedAt` (our crawl time) and
  `observedAt` (CMC quote `lastUpdated`), plus `freshnessSeconds` and `isStale`.
- Values: price, circulating market cap (never FDV; FDV has its own column), circulating supply,
  rolling-24h volume, CMC rank, `dateAdded` and raw tags, all as exact decimals.
- Missing values are NULL with a reason in `nullReasons`; `qualityFlags` and `completeness`
  describe each row.
- Indexes: the unique key, `(assetId, slotTime)` and `(slotTime)`.

### Batch record — `CrawlBatch`

- One row per provider and hour (unique on `(providerId, slotTime)`), computed from the
  snapshots actually stored for the slot, so a replay describes the same data.
- Holds `listedTotal`, `collected`, per-field non-null counts (`fieldCounts`), `missingRanks` and
  `duplicateRanks` within 1–1200, the source update-time range and `statusReasons`.
- Status COMPLETE / INCOMPLETE / FAILED decides whether the Review Queue is published.
- A failed crawl is recorded as a FAILED batch (a visible gap); it never replaces an earlier
  stored batch for the slot.

### Daily history — `DailyMetricRevision` → `DailyMetric`

- Fetched only for screen candidates, about one request per candidate per UTC day, looking back
  `TIER1_DAILY_LOOKBACK_DAYS`.
- `DailyMetricRevision` is append-only. A new revision is written only when the normalized
  values change (`contentHash`); each keeps the source route, request parameters, response
  SHA-256 and the exact source text of the fields used (`sourceFields`).
- `DailyMetric` is the effective row per `(providerId, cmcId, dateUtc)` and points at its
  current revision (`revisionId`, `revision`).
- `DailyFetchState` records the last request per coin, so a day CMC has not published yet is
  retried after `TIER1_DAILY_RETRY_HOURS` instead of on every run.

### Identity — `CmcAsset`, `CmcAssetChange`, `Asset`, `AssetIdentity`, `AssetContract`

- Tier 1 keys on the numeric CMC id (`CmcAsset`, primary key `(providerId, cmcId)`); a symbol
  never identifies a coin on its own.
- Changes of symbol, name, slug, tags, listing date or contract are logged in `CmcAssetChange`
  without creating a new asset.
- The older provider-neutral layer (`Asset` with a UUID, `AssetIdentity` per provider id,
  `AssetContract` per chain + contract) is still filled. `AssetIdentity.delistedAt` is set only
  after a complete discovery sweep no longer lists a coin.

### Venues — `VenueCrawl`, `VenuePairEvent`, `VenueMappingTask`, `VenueDecision`

- `VenueCrawl` stores each LBank Spot pair-list crawl (`lbank_spot_pairs`) and each review
  candidate's CMC Markets crawl (`asset_markets`), with the normalized pairs exactly as used,
  status, expected vs fetched counts and response hashes.
- `VenuePairEvent` records LBank listing transitions (LISTED, ABSENT) found by complete crawls.
- `VenueMappingTask` holds ambiguous LBank tickers for a reviewer; `VenueDecision` holds the
  reviewer's append-only decisions.

### Scan results — `ScanRun`, `ScanResult`

- `ScanRun` (one per batch): ruleset, config and overrides versions, counts, warnings, queue
  status, export status and files. Reprocessing updates it and increments `attempts`.
- `ScanResult` (one per coin per batch, unique on `(batchId, cmcId)`): the current inputs,
  window means, multiples, YES / NO / N/A with reasons, stars, eligibility status and reasons,
  LBank status and pairs, queue position. `dailyWindow` keeps the dates, values and daily
  revision ids used; `inputsHash` makes a replay comparable. A re-scan replaces the batch's rows,
  never duplicates them.

### Human records — `Review`, `VenueDecision`

- Append-only. Every save of a review is a new revision (`supersedesId` links them) with a copy of
  the Tier 1 record at review time (`tier1Snapshot`). Reviewer decisions never change stored
  source data.

### Runs and delivery

- `PipelineRun` and `PipelineStage`: one run per `(kind, slotTime, providerId)`, stage status,
  attempts, metrics (including live progress) and coverage.
- `TelegramDelivery`: every report part with its full text, mode, status and attempts;
  `(reportHash, partIndex, chatId)` suppresses duplicates.
- `JobLease` prevents overlapping runs; `SourceHealth` keeps circuit-breaker and request-budget
  state; `AppState` holds small durable values (Telegram access list and offset, retention
  watermark, fixture anchor date).

## Retention

| Data | Policy |
|---|---|
| `MarketSnapshot` | Every hour for `RETENTION_DETAIL_DAYS` (default 30). Afterwards, coins outside the Tier 1 band (rank 101–1200, or unranked with cap ≥ $15M) for the whole day ±72 h keep only their first snapshot of each UTC day; band coins keep every hour. `RETENTION_SNAPSHOT_DAYS` > 0 additionally deletes snapshots older than that (default 0 = keep). |
| `ScanResult` | Every batch for `RETENTION_DETAIL_DAYS`. Afterwards, rows excluded **only** by `RANK_OUT_OF_RANGE` / `MARKET_CAP_BELOW_MIN` keep the first batch of each UTC day; all other rows are kept. |
| Export files | Removed from disk after `EXPORT_RETENTION_DAYS` (default 7); the database keeps the history. |
| Everything else | Never pruned: batches, runs, stages, daily rows and revisions, fetch state, venue crawls and events, identity and change log, reviews, decisions, Telegram deliveries, and every forward-test table (watchlist, events, Highs, outcomes, trigger runs, rejections, update runs; added 2026-11-10, M008). |

Thinning works through whole UTC days older than the cutoff, at most three days per run,
resuming from the `retention.detailThinnedUntil.<provider>` watermark. It has not run yet: the
oldest live data is from 2026-11-05, so the first day becomes eligible around 2026-12-05.

## Current contents (2026-11-06, 23 live slots)

Database size: **418 MB**.

| Table | Total size | Rows | Notes |
|---|---|---|---|
| `MarketSnapshot` | 179 MB | 184,588 live + 1,301 fixture | ~800 B per row; 8,022–8,028 rows per slot |
| `ScanResult` | 177 MB | 184,588 live + 1,301 fixture | ~700 B per row |
| `DailyMetricRevision` | 22 MB | 20,529 live + 7,489 fixture | all `first`; no source revisions yet |
| `DailyMetric` | 7.9 MB | 20,529 live (579 coins) | 2026-10-01 … 2026-11-05, median 36 days per coin; 24 invalid |
| `CmcAsset` / `Asset` / `AssetIdentity` | 6.3 / 5.4 / 6.2 MB | 9,333 each | includes 1,301 fixture coins; none delisted |
| `AssetContract` | 2.7 MB | 7,022 | |
| `VenueCrawl` | 1.6 MB | 197 | 136 asset-markets and 5 LBank-list crawls live |
| `VenuePairEvent` | 0.3 MB | 1,172 | 1,170 LISTED, 2 ABSENT |
| `CrawlBatch` | < 0.1 MB | 24 | live: 14 COMPLETE, 9 INCOMPLETE |
| `PipelineRun` / `PipelineStage` | 0.3 / 0.2 MB | 24 / 192 | live: 13 succeeded, 10 partial |
| `TelegramDelivery` | 0.3 MB | 120 | 117 sent live, 3 dry-run |
| `VenueMappingTask` | 0.1 MB | 38 | all OPEN |
| `CmcAssetChange` | < 0.1 MB | 5 | 4 tag changes, 1 listing-date change |
| `Review`, `VenueDecision` | — | 0 | |

No tables are left over from the retired features (surge screen, agents, paper trading).

## Growth projection

Both large tables grow by about 15.5 MB per hour together (about 370 MB per day).

| Period | `MarketSnapshot` | `ScanResult` (current rule) | `ScanResult` (proposed rule, Finding 1) |
|---|---|---|---|
| First 30 days | ~5.6 GB | ~5.6 GB | ~5.6 GB |
| Per day afterwards | ~33 MB (1,100 band coins × 24 + ~6,900 daily rows) | ~177 MB (only 274 rows per batch thinned) | ~32 MB |
| Per year afterwards | ~12 GB | ~65 GB | ~12 GB |

Deleted rows free space inside PostgreSQL for reuse, so files level off rather than shrink;
returning space to the disk needs `VACUUM FULL` (locks the table), which is only worth running
once after a large cleanup.

## Findings

### 1. Scan-row thinning barely applies

The eligibility check records every failed reason, so a coin far outside the band usually
carries `RANK_OUT_OF_RANGE` together with `NO_LBANK_SPOT_PAIR`, `MARKET_CAP_MISSING`,
`TOKENIZED_ASSET` and others. The rule only thins rows whose reasons are a subset of
{`RANK_OUT_OF_RANGE`, `MARKET_CAP_BELOW_MIN`}. In the latest batch:

| Class | Rows |
|---|---|
| Kept: excluded with other reasons | 7,449 |
| Kept: ELIGIBLE | 288 |
| Thinned (rank/cap only) | 274 |
| Kept: NEEDS_REVIEW | 12 |

Most common reason sets among the kept rows outside rank 101–1200: `RANK_OUT_OF_RANGE +
NO_LBANK_SPOT_PAIR + MARKET_CAP_MISSING` (3,197) and `RANK_OUT_OF_RANGE + MARKET_CAP_BELOW_MIN +
NO_LBANK_SPOT_PAIR` (2,194).

**Proposal:** after the detail window, thin excluded rows that include `RANK_OUT_OF_RANGE`,
whatever their other reasons; such coins can never enter the queue. This changes the rule as
written in `intend.md` (unresolved decision 5, "excluded only by rank/cap"), so it needs the
operator's decision. `intend.md`, assumption A20 in the strategy document, the storage section of
`architecture.md` and the retention tests would be updated with it.

### 2. `nullReasons` is 45 % of each snapshot row

About 358 of 800 bytes per `MarketSnapshot` row are `nullReasons`, mostly the same reasons
repeated for columns the CMC website source never fills (hourly volume, spread, depth, liquidity
source). Recording "not supplied by this source" once per batch would shrink snapshots by about
40 %. This is a schema and semantics change; lower priority than Finding 1.

### 3. Synthetic fixture rows in the live database

A fixture run on 2026-11-05 11:00 UTC left 1,301 snapshots, 1,301 scan rows, 7,489 daily rows,
1,301 identities and one run in the live database. They are separated by
`providerId = 'fixture'`, and the dashboard, MCP and Telegram read only the configured source, so
they are harmless. They can be removed if a clean live database is preferred.

### 4. Two identity layers

`CmcAsset` (keyed by CMC id) and `Asset` / `AssetIdentity` (UUID, provider-neutral) describe the
same coins. Both are consistent (9,333 rows each); the overlap costs little storage but is worth
keeping in mind when adding a second live source.

### 5. Healthy

- Idempotent writes and unique keys on every per-slot table; replays verified by the DB tests.
- Indexes match the main queries (per-slot snapshot reads, per-batch scan sheets, per-coin traces).
- Daily revision lineage is complete (route, parameters, response hash, source text).
- Open work for the reviewer: 38 LBank mapping tasks.

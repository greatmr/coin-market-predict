# ADR-0008 — Storage scope: store per coin only what the strategy found

**Status:** Accepted, 2026-11-24 (operator decision D4: remove the Excluded, Needs review and
Eligible pages and exports; keep the screen, the Review Queue and the forward test).

## Context

Every hourly run stored one `market_snapshot` and one `scan_result` row for every listed coin
(~7,950). On a copy of production (2026-11-10 → 2026-11-24, 323 batches) the two tables were 98 %
of a 4.9 GB database with ~2.57 million rows each: 96.5 % of the scan rows were EXCLUDED, 2.6 %
ELIGIBLE without a star, 0.7 % the Review Queue, 0.1 % NEEDS_REVIEW; 84.8 % of the snapshots were
coins ranked above 1200, which can never pass the rank rule. The rows existed to fill three
dashboard pages and three CSV sheets. Retention (thinning after 30 days) would have reached the
scan rows only marginally (~3.8 % matched its rule).

The operator asked to remove those pages and exports and stop the per-coin history behind them,
while: every coin keeps being checked each hour so it can become a candidate later (838 times in
those 14 days a coin went from 0 stars to the queue an hour later; 28 % of all forward-test events
opened right after such a 0-star hour); missing or ambiguous data never becomes a signal; the
Review Queue (1, 2 and 3 stars, weighted ranking) and everything needed to inspect a qualifying
result stay; the forward test and its immutable event data are untouched; and the coins
themselves stay, ready to move back into the flow.

## Decision

- **Screen everything, store what qualifies.** Collection still reads and validates every listed
  coin and keeps every coin in the registry (`asset`, `asset_identity`, `cmc_asset`). Snapshots are
  stored for ranks 1–1200 only (`inStoredUniverse`): the Tier 1 band, the ranks the continuity
  check needs and BTC/ETH. Rank is the first, cheapest check; a coin ranked above 1200 or unranked
  is counted (`crawl_batch.collected` vs `stored`, migration M014) and stored again from the hour
  it ranks 1–1200.
- **The scan evaluates every stored coin in memory and stores only the Review Queue**
  (`inReviewQueue`, unchanged: ELIGIBLE with ≥ 1 YES, ordered by stars, then 60 / 25 / 15 weighted
  points). Every other coin is summarized on its `scan_run.counts`: totals by status, eligibility
  reasons, stars, YES / NO / N/A per window, N/A reasons, current-quote and LBank statuses, coins
  outside ranks 1–1200, and the ids lacking a daily row (for the repeated-missing warning).
- **NEEDS_REVIEW fails closed** (`needsDailyRows` = ELIGIBLE only, `RULESET_VERSION` `vmc-tier1-2`):
  no daily rows, windows or stars (`NOT_EVALUATED_NEEDS_REVIEW`), no venue rows. It never was a
  queue member; now it cannot even carry a star. Some candidates are missed while their data is
  unclear; that is accepted. Queue membership, thresholds and ranking are unchanged.
- **Traces on request.** The coin page, `tier1:trace`, MCP `get_asset_trace`, Telegram `/coin` and
  the coin agent read the stored queue row, or evaluate any other coin of the batch with the same
  code and stored inputs (`ScanService.evaluateCoins`; nothing is written, `inQueue` stays false;
  `evaluation.mode` says `stored`, `on_request` or `earlier_stored`). LBank venue decisions can still
  be recorded for such a coin; reviews only for stored queue rows.
- **Pages, exports, API.** The Eligible, Needs review and Excluded pages and nav items are removed
  (old links open Data); `GET /api/scan` and MCP `get_scan_results` serve the queue only; exports
  are `review_queue.csv` and `run_metadata.csv` (with the counts). "Needs review" is worded
  "Missing or ambiguous data" wherever it remains, so it is never confused with the Review Queue.
- **Retention.** After `RETENTION_DETAIL_DAYS` (default 7, was 30) a snapshot stays only as the
  input of a stored queue row, a forward-test detection snapshot (immutable: deleting it would fail
  on the M008 trigger) or a BTC/ETH benchmark. Review Queue rows, daily rows and revisions (the
  3/7/30-day baselines), crawl batches, scan runs, reviews, decisions, the coin registry and every
  forward-test table are never pruned.
- **Cleanup is manual and gated.** Migrations run on every deploy, so the cleanup is not one:
  `npm run cli -- storage:prune` (dry run by default, `--apply`, `--vacuum`) runs under the pipeline
  lease, deletes batch by batch / slot by slot, keeps rows a review or venue decision names, and
  sets the retention watermark. Until it has run, hourly retention deletes no snapshot at all, so a
  deploy never removes earlier data before the operator's backup.

## Consequences

- Per hourly run: ~57 scan rows (the queue) and 1,200 snapshots instead of ~7,950 + ~7,970. On the
  production copy, the cleanup took the database from 5,144 MB to 412 MB (`scan_result` 2.56 M →
  18.5 K rows, `market_snapshot` 2.58 M → 224 K) in 6.5 minutes; every forward-test event kept its
  snapshot, every queue row its inputs.
- The latest real batch, re-scanned with the new code, gave exactly the same queue (58 coins,
  order, stars, points and prices) while storing 58 rows instead of 7,886.
- A coin outside the queue has no per-hour history: its trace is available for hours whose
  snapshot is still stored (the last `RETENTION_DETAIL_DAYS`), and its price chart is short until it
  ranks 1–1200. Its eligibility history per hour is no longer kept; only the run counts are.
- `RULESET_VERSION` changed to `vmc-tier1-2`: rows record which rules evaluated them; the forward
  test's dedup key (CMC id, UTC date, stars) does not include it.
- The remaining growth is the queue: ~1,400 rows a day (~5 KB each, most of it the venue summary in
  `diagnostics`) plus their snapshots. A follow-up could store the venue summary once per venue crawl.

## Moving coins back

Nothing about a coin is deleted except per-hour rows. Storing other statuses again needs no
migration (columns and enums are unchanged): it is the filter before the insert in
`ScanService.evaluateAndPersist` and the `inStoredUniverse` filter in `IngestionService.collect`.

## Alternatives rejected

- **Keep every snapshot but delete out-of-band ones after a day.** Keeps traces for every coin, but
  writes and deletes ~6,700 rows an hour for coins that can never pass the rank rule.
- **A per-coin "current state" table upserted hourly.** Duplicates what the scan run counts and an
  on-request evaluation already give, with ~8,000 updates an hour.
- **A migration for the cleanup.** It would run unattended on deploy, before a backup.

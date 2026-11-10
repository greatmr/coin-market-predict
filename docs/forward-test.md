# Star Event Forward Test

Source: **"Star Event Forward Test — Automatic watchlist • Daily High • 168h + end-of-day"**
(developer add-on to the existing CoinMarketCap scanner, 10 Nov 2026, 12 pages; text edition).
Page references are written `(p.N)`. It is an add-on to the
[Two-Tier VMC strategy](strategy-two-tier-vmc.md), not a replacement: no Tier 1 eligibility,
VMC or star rule changed, so `RULESET_VERSION` is unchanged. Module boundary:
[ADR-0004](adr/0004-forward-test-module.md).

> A descriptive measurement for research. The result is the **highest future High observed
> after a star detection, against the CMC price at detection**: not an executable trade, not a
> close-to-close return, not realized P/L (no fees, spread or slippage). Nothing here places
> orders, sends Telegram signals or defines a "pumped" threshold (p.2, p.8, p.9, p.10).

## 1. What it does (p.1–3)

1. **Capture** — after each hourly publication of the Tier 1 Review Queue, every eligible
   1/2/3-star row opens an event at the CMC price of that scan, unless the same coin already has
   an event for that UTC date and star count. No human approval exists anywhere in the path.
2. **Follow** — once per closed UTC day, the event's eligible daily Highs are stored and its
   running maximum is recomputed.
3. **Compare** — the event is FINAL after the end of the UTC day containing
   `detected_at + 168 h`, once every included day has a High; results are grouped by stars.

| Owner decision (p.2) | Implementation |
|---|---|
| Eligible 1/2/3-star scanner results trigger tracking immediately; no approval | Pipeline stage `forward` after `notify` reads the batch's published queue (§ 3); the coin is added to `forward_test_watchlist` automatically |
| Same stars on the same UTC date → no new event; a different star count → a new event; a later UTC date → a new event even while an older one is open | `UNIQUE (provider_id, cmc_id, detected_utc_date, star_count)`, `INSERT … ON CONFLICT DO NOTHING` (§ 4) |
| The CMC price of the qualifying scan is the immutable reference | `forward_event.snapshot_price_usd`; a database trigger refuses any change to the detection snapshot |
| Check future Highs once per day | the daily update runs at the first hourly run after each UTC day closes, and is retried while Highs are missing (§ 7) |
| Anchor at detection + 168 h and include the rest of that UTC day | `deadline_168h`, `evaluation_end` (§ 5) |

## 2. Where to find it

| Surface | What |
|---|---|
| Dashboard | **Forward test** tab: star groups, pass-pattern and weighted-points tables, final-return distribution, detection hours, Active / Final / Incomplete / All events, rejected triggers, downloads, *Update Highs now* |
| API | `GET /api/forward` (report), `GET /api/forward/events?view=active\|final\|incomplete\|all&stars=&search=`, `GET /api/forward/events/:id`, `GET /api/forward/rejections`, `GET /api/forward/export/<sheet>.csv\|workbook.xlsx` (`exports:read`), `POST /api/forward/update` (`scan:operate`) |
| MCP (read-only) | `get_forward_test_summary`, `get_forward_events`, `get_forward_event` |
| CLI | `forward:status`, `forward:events`, `forward:update`, `forward:export` (§ 12) |
| Files | `<TIER1_EXPORT_DIR>/<provider>/<time>Z_forward-test[_SYNTHETIC]/` after each daily update; samples in [examples/](examples/README.md) |

## 3. Adapter: published Review Queue → event (p.3, p.5)

The trigger reads the stored scanner output of the batch (`scan_result` rows with
`in_queue = true`, the run's `scan_run.queue_status`, the `crawl_batch`, the `cmc_asset`
identity and the `market_snapshot` row) — the same data as the `Review_Queue` export sheet.

| Event field | Review_Queue export column | Stored from | Note |
|---|---|---|---|
| `cmc_id` | `cmc_id` | `scan_result.cmc_id` | canonical identity, never the symbol |
| `star_count` | `stars` | `scan_result.stars` | taken as published, never recalculated |
| `detected_at` | `observed_at_utc` | `scan_result.crawled_at` | the batch's crawl time = the scan's as-of time (F1) |
| `detected_utc_date` | — | UTC date of `detected_at` | key part; never the display timezone |
| `snapshot_price_usd` | `price_usd` | `scan_result.price_usd` | `numeric(38,18)`, full stored precision (U4) |
| `source_updated_at` | `source_updated_at` | `scan_result.observed_at` | provider update time of that quote |
| `source_batch_id`, `slot_time` | `crawl_batch_id` | `crawl_batch` | foreign key, `RESTRICT` |
| `pass_3d/7d/30d`, `multiple_3d/7d/30d`, `current_vmc`, `vmc_3d/7d/14d/30d_avg` | same names | `scan_result` | |
| `lbank_pairs`, `queue_order`, `rank`, `cap_usd`, `volume_24h_usd`, `symbol`, `name`, `slug` | same names | `scan_result` | |
| `ruleset_version`, `config_version`, `inputs_hash` | same names | `scan_result` | Tier 1 lineage |
| `weighted_pass_points`, `score_complete`, `weighted_strength`, `ranking_ruleset_version` | same names | `scan_result` | the weighted star ranking known at detection ([strategy § 6a](strategy-two-tier-vmc.md#6a-weighted-star-ranking-weighted_star_v1-operator-decision-d3)); a later score on the same key never replaces it (F13) |
| `platform_chain`, `platform_address` | — | `cmc_asset` | contract / network evidence |
| `snapshot_id` | — | `market_snapshot.id` | provenance link (`SET NULL`) |
| `scan_snapshot` | every column | the whole `scan_result` row | kept because reprocessing replaces scan rows |

**A row opens a priced event only if** the queue is `PUBLISHED`, the batch `COMPLETE`, the row in
the queue, `ELIGIBLE`, with 1–3 stars and a `VERIFIED` LBank pair; the CMC id is a positive integer
with exactly one stored identity and one observation in the batch; the price is finite and > 0;
the quote is `OK` and not older than `MAX_QUOTE_AGE_MINUTES`; both timestamps exist; and the batch
is not older than `MAX_QUOTE_AGE_MINUTES` when the trigger runs (a replay is not a live forward
test, F3). Otherwise `forward_trigger_rejection` keeps the row with every reason
(`QUEUE_NOT_PUBLISHED:<status>`, `BATCH_NOT_COMPLETE:<status>`, `NOT_IN_REVIEW_QUEUE`,
`NOT_ELIGIBLE:<status>`, `STARS_OUT_OF_RANGE:<n>`, `LBANK_NOT_VERIFIED:<status>`,
`CMC_ID_MISSING`, `ASSET_ID_AMBIGUOUS`, `PRICE_MISSING`, `PRICE_NOT_FINITE`,
`PRICE_NOT_POSITIVE`, `QUOTE_STALE`, `QUOTE_NOT_OK:<status>`, `SOURCE_TIME_MISSING`,
`OBSERVED_AT_MISSING`, `TRIGGER_BATCH_NOT_CURRENT`) and the values it saw, unrepaired.
Rows outside the queue (0 stars, not eligible) are not triggers at all.

## 4. Identity and deduplication (p.4)

- Key: `(provider_id, cmc_id, detected_utc_date, star_count)` (F2). The first insert wins; a
  later sighting of the same key is counted as *ignored* on its `forward_trigger_run` with the id
  of the event that keeps the first price and time. Concurrent workers race on the constraint, not
  on a prior read, so a duplicate cannot be created.
- 1 → 2 → 3 stars on one UTC date: three events. 2 → 3 → 2: the second 2-star sighting is
  ignored. The next UTC date opens a fresh event even while yesterday's is open. Each event has its
  own window and Highs.
- Several events of one coin, or of one day, are correlated observations: exports and the API
  give each event `asset_event_count` and the ids of the same coin's events with overlapping
  windows; the star-group report counts them (§ 9).

## 5. Window (p.6)

```
detected_at       = crawl time of the first qualifying observation
deadline_168h     = detected_at + 168 h
evaluation_end    = 23:59:59.999 UTC on the date containing deadline_168h
included Highs    = from detected_at (inclusive) through evaluation_end (inclusive): 8 UTC dates
effective_horizon = length of [detected_at, evaluation_end] in hours: (168, 192]
```
Example: 10 Nov 14:00 UTC → deadline 17 Nov 14:00 → included until 17 Nov 23:59:59.999 (178 h).
A peak after `deadline_168h` sets `extension_peak_flag = TRUE`.

## 6. High data: source and interval coverage (p.5, p.6)

**Source.** The existing crawler's daily OHLC route
(`/data-api/v3.1/cryptocurrency/historical?interval=1d`, USD), already stored per completed UTC
day as `daily_metric_revision.high_usd` with every revision. It is requested by CMC id and the
parser rejects a response for another id, so a High always belongs to the event's own asset.
Every `forward_high` row keeps its source, source revision id, quote currency (USD) and
retrieval time.

**Targeted capture added (the smallest that the rules need):**
1. CMC publishes the documented time of each day's High and Low (`timeHigh`, `timeLow`, minute
   resolution) in the same response; the parser used to drop them. They are now stored on
   `daily_metric_revision.time_high` / `time_low` (migration M008). They are not part of the row's
   content hash, so capturing them never creates a revision by itself (F11).
2. Tracked coins that are no longer screen candidates get the same daily-history request from the
   daily update (same budget, rate limit, retry and circuit rules, at most 10 minutes per update;
   the rest continues at the retry). Screen candidates already get their rows from the `daily`
   stage, so in practice few extra requests are made.

**Never used as a High:** Close, the hourly listing price (a sampled last price), chart points,
or an LBank Spot High (a different series without a captured LBank reference price).

| Included period | Covered by | Counts when | Otherwise |
|---|---|---|---|
| Signal day (day 0) | that UTC day's High | its `time_high` ≥ `detected_at` (DAY0_POST_SIGNAL), or detection exactly at 00:00:00.000 (a full day) | `DAY0_UNPROVEN`: the full-day High is only an upper bound of the unknown post-signal part. If a later day's High is ≥ it, the peak is exact (shortcut); else `INCOMPLETE_DAY0` with the later maximum as a lower bound |
| Days 1–6 | that day's High | finite > 0, USD, exactly one UTC day | `HIGH_MISSING:<date>` / `HIGH_INVALID:<date>:<reason>`, never filled |
| Final day (date of `deadline_168h`) | that day's High | same; includes the end-of-day extension | still missing after the window: `AWAITING_FINAL_DAY` (late final day) |
| After `evaluation_end`, before `detected_at` | — | never | excluded |

The peak is the largest eligible High; ties go to the earliest. Its time is the source's
`time_high` (`SOURCE_TIME`) or, if unknown, only its UTC day (`UTC_DAY`); with `UTC_DAY` on the final
day, `extension_peak_flag` is `UNKNOWN`. When a later High equals the unproven day-0 High, the value
is exact but the earliest time is not (`PEAK_TIE_UNOBSERVED_DAY0`, extension `UNKNOWN` if it
would otherwise be `TRUE`).

## 7. Daily update, statuses and versions (p.7, p.10)

| Status | Meaning |
|---|---|
| `OPEN` | recorded; the signal day has not closed yet |
| `TRACKING` | at least one included day closed; running maximum is provisional |
| `AWAITING_FINAL_DAY` | `deadline_168h` passed and the final day is not complete, or the window closed and the final day's High is the only one still missing |
| `FINAL` | the window closed, every included day has an eligible High and day 0 is settled |
| `INCOMPLETE` | the window closed with any other gap (`HIGH_MISSING`, `HIGH_INVALID`, `INCOMPLETE_DAY0`); the peak is a lower bound; missing days are still retried |

**When.** The hourly `forward` stage records events every run and runs the update when it is
due: at the first run after a UTC day closes; again after `TIER1_DAILY_RETRY_HOURS` while an
included High is missing (for up to `MISSING_DATA_RETRY_DAYS` = 3 days after `evaluation_end`);
and at the next run after a failure. A failed forward stage marks the run `partial` and never
fails the scan, exports or Telegram. Manually: `forward:update` or *Update Highs now*, under the
pipeline lease.

**How.** For every event that is not FINAL — and FINAL events while their days can still be
revised (`evaluation_end` within `TIER1_DAILY_LOOKBACK_DAYS`) — the update reads the effective
daily row of each completed included date, classifies its High (§ 6) and upserts a
`forward_high` row keyed by `(event_id, period_start, source, source_revision_id)`. A late source
revision adds a new row and marks the previous one superseded (`is_current = false`, kept). The
outcome is recomputed from the current rows; when anything changed (status, peak, coverage, the
rows used), the next `forward_outcome.result_version` is written (`first`, `daily_update` or
`source_revision`). Rerunning adds nothing. Events never become FINAL early because of a pump, nor
because seven calendar dates elapsed.

## 8. Storage model (p.8)

| Spec | Table | Content |
|---|---|---|
| `forward_events` | `forward_event` | the immutable detection snapshot (§ 3, including the ranking fields since M009), `deadline_168h`, `evaluation_end`, `effective_horizon_hours`, `rules_version`; tracking state `status`, `quality_flags`, `result_version`, `last_update_at`, `finalized_at`. Unique key § 4; checks `star_count BETWEEN 1 AND 3`, `snapshot_price_usd > 0`; trigger `forward_event_immutable_snapshot` |
| `forward_highs` | `forward_high` | `event_id`, `date_utc`, `period_start/end`, `source`, `source_revision_id` (→ `daily_metric_revision`), `revision`, `high_usd`, `time_high`, `quote_currency`, `observed_at` (retrieved), `eligibility`, `reason`, `is_current`, `superseded_at` |
| `forward_outcomes` | `forward_outcome` | one row per `result_version`: `status`, `coverage_status`, `peak_kind` (EXACT / LOWER_BOUND / NONE), `peak_high_usd`, `peak_high_id`, `peak_at`, `peak_time_precision`, `peak_period_start/end`, `peak_return_pct`, `extension_peak_flag`, `effective_horizon_hours`, `day0_state`, covered / completed days, missing and invalid dates, reasons, the High rows used, `finalized_at`, `rules_version` |
| watchlist | `forward_test_watchlist` | one row per coin: identity and contract evidence at the first event, first / last event time, event count. Events reference it (`RESTRICT`): removing a coin can never delete its history |
| failed triggers | `forward_trigger_rejection` | one row per batch, coin and star count: reasons and observed values |
| batch log | `forward_trigger_run` | each reading of a published queue: rows seen, created, ignored (with the existing event id), rejected |
| update log | `forward_update_run` | each daily update: covered date, status, counts, coverage, fetch report, notes |
| High capture | `daily_metric_revision.time_high`, `time_low` | § 6 |

Snake_case singular names follow [ADR-0001](adr/0001-typeorm-modular-layout.md). Nothing here is
ever pruned (p.10); retention never touches these tables.

## 9. Metric and reports (p.8, p.9)

```
peak_return_pct = 100 × (peak_high_usd / snapshot_price_usd − 1)    exact decimals, stored at 30 dp
```
`peak_kind = EXACT` only for FINAL events; every other value is a provisional lower bound and is
shown as `≥ x %`. The initial price is never overwritten.

**Event export** (one row per event, overlapping 2- and 3-star events as separate rows): sheets
`Events_Active` (OPEN, TRACKING, AWAITING_FINAL_DAY), `Events_Final`, `Events_Incomplete`, with
`event_id, cmc_id, symbol, name, detected_at_utc, detected_utc_date, detection_hour_utc,
star_count, reference_price_usd, source_updated_at_utc, source_batch_id, pass_3d, pass_7d,
pass_30d, multiple_3d, multiple_7d, multiple_30d, pass_pattern, weighted_pass_points,
score_complete, weighted_strength, ranking_ruleset_version, current_vmc, lbank_pairs, ruleset_version,
deadline_168h_utc, evaluation_end_utc, effective_horizon_hours, status, coverage_status,
peak_kind, highest_future_high_usd, high_time_utc, high_interval_start_utc,
high_interval_end_utc, high_time_precision, peak_return_pct, extension_peak_flag, day0_state,
completed_days, covered_days, expected_days, missing_dates, invalid_dates, data_quality,
result_version, revision_reason, rules_version, last_update_utc, finalized_at_utc,
asset_event_count, overlapping_event_ids, data_label`.

**Star-group report** (`Cohort_Summary`, one row per group with its `dimension`: star count
1★ / 2★ / 3★ / all; detection-time **pass pattern** such as `NO/YES/YES`, listed in the queue order
of the pattern; and **weighted-points band** — complete scores in fixed equal-width bands 75–100,
50–74, 25–49, 0–24 points, with incomplete (lower-bound) scores and events detected before the
ranking in groups of their own, F14): events, distinct coins,
FINAL / incomplete / pending (open + tracking + awaiting) counts; over **FINAL events only** the
mean, median, p25, p75, minimum and maximum `peak_return_pct` (percentiles: linear interpolation
between order statistics, Hyndman–Fan type 7); correlation counts (coins with several events and
their events, overlapping same-coin pairs, detection dates with several events). `Distributions`:
final returns in display bins (< 0, 0–5, 5–10, 10–20, 20–50, 50–100, ≥ 100 % — descriptive, not
thresholds), events by UTC detection hour, and effective horizons in 4-hour bins (the end-of-day
extension depends on the signal time). Also `Rejected_Triggers` (last 30 days) and
`Run_Metadata`. CSV keeps full precision; XLSX cells are numbers for display.

## 10. Error handling (p.10)

| Situation | Behaviour |
|---|---|
| Queue row without price / time / CMC id, invalid or stale price, ambiguous id, incomplete batch, withheld queue | no event; `forward_trigger_rejection` with reasons |
| Duplicate key | first price and time unchanged; counted as ignored on the trigger run |
| High missing, non-USD or not one UTC day | `HIGH_MISSING` / `HIGH_INVALID`; never filled with Close; INCOMPLETE once the window closed |
| Signal-day High without post-signal proof | `DAY0_UNRESOLVED` while tracking, `INCOMPLETE_DAY0` after; lower bound kept |
| Late final day | `AWAITING_FINAL_DAY` |
| Crawler failure / source unavailable | earlier outcome versions stay; the update run is `partial` or `failed`; the report shows `FRESHNESS`, `UPDATE_PARTIAL` or `UPDATE_FAILED` |
| Late source revision | new `forward_high` row, previous one superseded; new outcome version; detection snapshot unchanged |
| Contract / network evidence changed after detection | still followed by CMC id; flagged `CONTRACT_EVIDENCE_CHANGED` for a human (F9) |

Observability: trigger runs per batch (created / ignored / rejected), status counts, High coverage
(covered / completed days, missing, invalid, day 0 unresolved), last daily update and last
successful update.

## 11. Acceptance evidence (p.11)

| Case | Evidence |
|---|---|
| 10 Nov: 10:00 2★ $10 → A; 11:00 2★ $11 → none; 15:00 3★ $12 → B; 18:00 2★ $13 → none; 11 Nov 09:00 2★ $14 → C. Exactly three rows, A stays $10, B stays $12, rerunning any batch creates none | `test/forward-test.e2e-spec.ts` › *the 10 Nov timeline creates exactly A, B and C* |
| Concurrent workers cannot duplicate | e2e › *concurrent workers cannot create a duplicate* |
| 0-star row, stale quote, missing CMC id, coin outside the queue → no priced event; an eligible 1-star row creates the watchlist entry and event without a click | e2e › *a 0-star row, a stale quote…*; `forward-rules.spec.ts` › *trigger validation* |
| Incomplete batch / withheld queue, replayed old batch → nothing, reasons kept | e2e › *a withheld queue…* |
| 10 Nov 14:00 → deadline 17 Nov 14:00, `evaluation_end` 17 Nov 23:59:59.999 | `forward-rules.spec.ts` › *event window*; e2e |
| A High on 17 Nov 20:00 is included with `extension_peak_flag = TRUE`; 18 Nov 00:00 is excluded; 10 Nov 09:00 is excluded | unit › *daily High eligibility*, *outcome*; e2e › *excludes the pre-signal and after-window Highs…* |
| Price $10, eligible maximum $15 → 50 % | unit › *price $10 and an eligible future maximum High $15*; e2e |
| A same-day pre-signal High $20 never gives 100 %; a later $21 settles the peak exactly (110 %); a later $15 leaves day-0 coverage needed (INCOMPLETE_DAY0, lower bound 50 %) | unit › *outcome*; e2e (database round trip, then a source revision of 13 Nov to $21 → FINAL, 110 %, version 3 `source_revision`, superseded row kept, price unchanged) |
| Overlaps | `cohort.spec.ts` › *identifies correlated observations*; e2e timeline (`overlappingEventIds`) |
| Revised High reprocessing | unit › *a revised High is reprocessed*; e2e (above) |
| FINAL only after the last included day is complete and coverage passes | unit › *status lifecycle*; e2e › *never claims FINAL before the final day has a High* |
| Detection snapshot immutable | e2e › *keeps the detection snapshot immutable in the database* |
| Hourly pipeline on the synthetic market: one event per published queue row, none on reprocessing or re-runs, daily update to FINAL / INCOMPLETE_DAY0, peaks recomputable from the stored Highs, export with checksums | e2e › *records the published queue as events…* |
| A forward-test failure never fails the hourly run | e2e › *a forward-test failure never fails the hourly run* |
| Ranking addendum § 5–6: the same coin keeps 2 stars twice on one UTC date with different points → one 2-star event with the first snapshot (YES/YES/NO, 85, strength 1.91); a later 3-star result → its own event; the snapshot is immutable | e2e › *snapshots the ranking known at detection…*; pipeline events copy the scanner's ranking (e2e › *records the published queue…*) |
| Outcomes compared by star count, pass pattern and weighted-points band, with counts and quality | `cohort.spec.ts` › *by pass pattern and weighted-points band* |

## 12. Runbook

**Local**
```bash
npm run db:migrate                        # M008 (back up first: operator-guide § 9)
npm start                                 # the hourly run records events and updates Highs
npm run cli -- forward:status             # star groups, coverage, last trigger / update, warnings
npm run cli -- forward:events --view active    # or final | incomplete | all, --stars 1|2|3, --json
npm run cli -- forward:update             # the daily High update now (normally automatic)
npm run cli -- forward:export             # CSV + XLSX + manifest under TIER1_EXPORT_DIR
```

**Production host** ([deployment.md](deployment.md); migrations run at container start):
```bash
ssh jahantalab
cd /root/jahan/market-predict
alias dc='docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod'
dc exec -T postgres pg_dump -U coins coins | gzip > ~/coins-$(date +%F)-pre-m008.sql.gz
git pull
dc up -d --build                          # applies M008, then starts the app
dc exec app node dist/cli.js db:status    # all migrations applied, M008 included
dc exec app node dist/cli.js forward:status
```
Events appear from the next hourly run whose Review Queue is `PUBLISHED`; the first outcomes
appear the day after; the first FINAL events about eight days after deployment. Signals from
before the deployment are not backfilled (p.12).

**Daily check**: `forward:status` (or the tab). `FRESHNESS` / `UPDATE_FAILED`: look at the run's
`forward` stage and the source health (*Runs & health*); outcomes stay as they were until it runs.
`UPDATE_PARTIAL`: Highs not published yet are retried automatically. `INCOMPLETE_DAY0`: expected
without an intraday source (U1); those peaks are lower bounds and stay out of the primary
aggregates.

**Rollback**: M008 only adds tables and two nullable columns, which older code ignores; check out
the previous commit and rebuild. Do not run `db:revert` on real data.

## 13. Implementation assumptions

| Id | Assumption | Why |
|---|---|---|
| F1 | `detected_at` is the batch's crawl time (`observed_at_utc` of the queue export); the reference price is the quote observed at `source_updated_at`, at most `MAX_QUOTE_AGE_MINUTES` earlier | The scan's as-of time is the crawl time (strategy A1); the PDF asks for both timestamps |
| F2 | The key includes `provider_id` | One provider per deployment; keeps synthetic fixture events apart from live ones |
| F3 | Only the hourly run's publication triggers. Reprocessing (`tier1:scan`, *Reprocess*, LBank refresh) never creates or changes events; a batch older than `MAX_QUOTE_AGE_MINUTES` at trigger time is rejected (`TRIGGER_BATCH_NOT_CURRENT`) | "Do not backfill historical signals as if they were live forward tests" (p.12) |
| F4 | Day-0 proof is `time_high ≥ detected_at` as published (CMC: minute resolution) | p.6 "documented time_high is on/after detection" |
| F5 | `effective_horizon_hours` = length of `[detected_at, evaluation_end]` at millisecond resolution (178 h for 14:00) | p.6 lists it without a formula |
| F6 | Ties between days go to the earliest day; a tie with the unobserved day-0 part keeps the exact value, flags `PEAK_TIE_UNOBSERVED_DAY0` and makes a `TRUE` extension flag `UNKNOWN` | p.7 tie rule; p.8 UNKNOWN rule |
| F7 | `AWAITING_FINAL_DAY` also after the window when the final day is the only missing High; any other gap then is `INCOMPLETE` | p.7 and p.10 ("late final day") |
| F8 | Missing Highs are retried for 3 days after `evaluation_end`; FINAL events are re-evaluated for revisions while within `TIER1_DAILY_LOOKBACK_DAYS` | The crawler re-reads that many days; bounded requests |
| F9 | A changed contract / network is flagged, not resolved automatically | p.5 identity; CMC keeps one id across migrations |
| F10 | Distribution bins are display bins; percentiles are type 7 | p.9 asks for p25 / p75 and the distribution without definitions |
| F11 | `time_high` / `time_low` are outside the daily row's content hash | Capturing them must not create revisions or change Tier 1 lineage |
| F12 | Statuses change at each daily update, not hourly; the tab shows when it last ran | "Check future highs once per day" (p.2) |
| F13 | The ranking fields are copied from the published scan row like every other scanner field; events detected before `weighted_star_v1` keep NULL (never back-filled) | Ranking addendum § 5: features known at detection, never rewritten |
| F14 | Weighted-points bands are equal-width and fixed in advance (75–100, 50–74, 25–49, 0–24); only complete scores are banded | The addendum names "weighted score bands" without boundaries; fixed bands keep the later evaluation of the weights out of sample |

## 14. Unresolved upstream data gaps

| Id | Gap | Effect | What would close it |
|---|---|---|---|
| U1 | No verified CMC route returns intraday OHLC (a true post-detection High) for the signal day | Day 0 is settled only by CMC's `timeHigh` or the shortcut; otherwise `INCOMPLETE_DAY0` with a lower bound. How often depends on how often a coin's daily High comes before the detection hour and is never exceeded later (synthetic demo: 10 of 1,047 events; not a live estimate) | An intraday High source, after a [source assessment](../.claude/skills/source-assessment/SKILL.md) and an operator decision; it would add `forward_high` rows for the partial day |
| U2 | `time_high` exists only for daily rows stored after M008 | None for events (no backfill); a source change of `timeHigh` alone is not stored as a revision (F11) | — |
| U3 | No LBank reference price or LBank High is captured | The metric is CMC-only by design (p.5) | A separately captured LBank reference with its own label |
| U4 | The existing listing parser carries the price as a JavaScript number before storage | CMC publishes it as a JSON number, so its shortest representation is stored; source text beyond that is not kept | Keep the exact listing text in the crawler (not needed for this metric) |
| U5 | CMC publishes a closed day some time after 00:00 UTC | `AWAITING_FINAL_DAY` until it arrives; retried automatically | — |

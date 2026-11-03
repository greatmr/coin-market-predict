# Volume / Market Cap baseline collection

Implements the brief **"Volume / Market Cap — Data collection flow and implementation brief"**
(CoinMarketCap, 03 Nov 2026, 8 pages). Scope: collection, calculation, storage and a
descriptive comparison. **No signals, thresholds, alerts or recommendations** (PDF p.8:
"No trading signal rule is assumed in this brief").

## 1. What the brief asks for (with page references)

| Step | Brief | Implementation |
|---|---|---|
| Purpose | Measure each asset against its own six-month volume-to-market-cap baseline; keep hourly snapshots for the latest 72 h plus the live value (p.1) | `src/vmc/` module |
| 1 Choose assets | Persist each asset's CoinMarketCap ID; a ticker can be ambiguous (p.1, p.2 listing screenshot) | `VMC_ASSET_IDS` (explicit numeric ids) → `VmcAsset` keyed by `cmcId` |
| 2 Build baseline | Six months of completed daily Volume and Market Cap; daily ratio = volume ÷ same-day market cap; baseline = arithmetic mean of valid daily ratios; recompute weekly (p.1, p.4 Litecoin history screenshot, p.7) | `vmc:daily` + `vmc:baseline` (`vmc:weekly`) |
| 3 Track 72 h | Backfill hourly snapshots once, then one new snapshot every hour; upsert by CMC id + UTC hour; keep the last 72 h (p.1, p.6, p.7) | `vmc:hourly-backfill`, `vmc:hourly` |
| 4 Store & compare | Show historical mean, recent hourly ratios, latest ratio and timestamps together (p.1) | `vmc:compare`, `/api/vmc/comparison`, dashboard section |
| Validation | Reject missing values and market cap ≤ 0; flag assets with < six months of history instead of treating a partial window as full (p.7) | `validatePair`, baseline `status = partial/unavailable` |
| Route | Prefer official API over browser automation; daily = historical OHLCV *or* end-of-day historical quote, one convention consistently; hourly backfill = historical quotes with hourly interval subject to plan; live = latest quotes; the UI Volume/Mcap column is a cross-check only (p.8) | Official endpoints only; `VMC_DAILY_CONVENTION` |
| Acceptance | Daily ratio agrees with manual calc; mean averages ratios not totals; one snapshot per asset per UTC hour; missing hours visible; historical refresh does not duplicate (p.8) | Covered by `test/unit/vmc.test.ts`, `test/db/vmc.db.test.ts` |

Screenshots: p.2 main listing with the *Columns* control; p.3 Litecoin page with *See historical
data* (shows UCID 2 = CMC id 2); p.4 Litecoin daily history (Date, OHLC, **Volume**, **Market
Cap**); p.5 Columns menu → *Volume / Mcap* with the note that this column uses rolling 24 h
volume; p.6 listing with the *Volume / Mcap* column (e.g. BTC 0.01609, ETH 0.03138).

**Explicit vs assumed.** Explicit: CMC id as key, six-month window, daily ratio formula,
arithmetic mean, weekly refresh, one-time 72 h backfill, hourly collection, upsert by id + UTC
hour, minimum records, validation rule. Assumed (documented here, configurable): window
boundary definition (§4), EOD-quote day assignment (§3), coverage threshold for "full"
(`VMC_MIN_BASELINE_COVERAGE=0.95`), bucketing by observation time, stale threshold (90 min),
weekly schedule Monday 01:30 UTC, correction look-back 14 days.

## 2. Daily history vs hourly rolling-volume snapshots

| | Daily history (baseline input) | Hourly snapshot (recent window / live) |
|---|---|---|
| What volume means | Volume of one completed UTC day (OHLCV) or rolling 24 h volume sampled at midnight (EOD quote) | **Rolling 24 h volume** at the observation time — *not* volume traded within that hour (p.5, p.6) |
| Market cap | Same-day value from the same record | Value at the observation time |
| Table | `VmcDailyObservation` | `VmcHourlySnapshot` |
| Used for | Six-month baseline only | Comparison output only |

Hourly snapshots are never used in the baseline and adjacent rolling totals are never
subtracted to produce "hourly volume". The website table on p.4 corresponds to the OHLCV daily
convention; the Volume/Mcap column on p.5–6 corresponds to the hourly snapshot semantics.

## 3. Official endpoints and plan capability (verified 2026-11-03)

Sources: CMC API reference `pro-api-reference/cryptocurrency`, `tools/key-info`, guides
`errors-and-rate-limits` and `authentication`, `api/pricing` (all linked from p.8).
Authentication: header `X-CMC_PRO_API_KEY` (never query string; never stored).

| Purpose | Endpoint | Semantics used | Credits (docs) | Plan availability (docs) |
|---|---|---|---|---|
| Plan check | `GET /v1/key/info` | `plan.credit_limit_monthly`, `rate_limit_minute`, `usage.current_month` | not stated (treated as 0) | not stated |
| Identity | `GET /v1/cryptocurrency/map` | `id`, `name`, `symbol`, `slug`, `is_active`, `first_historical_data` | "No credit is needed" | all plans |
| Daily (default `eod_quote`) | `GET /v3/cryptocurrency/quotes/historical?interval=daily` | "first quote available" at the start of each UTC day; a sample at day D 00:0x → completed day **D−1**; uses `quote.USD.volume_24h`, `market_cap` from the same quote | 1 per 100 data points | Basic: daily 1 year; Builder: 3 years; Startup+: from 2010 |
| Daily (alt `ohlcv`) | `GET /v2/cryptocurrency/ohlcv/historical?time_period=daily` | `time_open` 00:00 → `time_close` 23:59:59.999; `quote.USD.volume`, `market_cap`; incomplete current day skipped | 1 per 100 data points | Startup+ documented; Basic/Builder ambiguous → **probe** |
| Hourly backfill | `GET /v3/cryptocurrency/quotes/historical?interval=hourly` | first quote in each UTC hour; empty hours skipped by the API (stay missing) | 1 per 100 data points | intraday (5m–12h): Basic 1 month, Growth 3 months, Professional 12 months |
| Live hourly | `GET /v3/cryptocurrency/quotes/latest` | `quote[USD].volume_24h`, `market_cap`, `last_updated` (cache 15–25 s) | 1 per 250 assets | all plans |

`npm run cli -- vmc:probe` calls `/v1/key/info` plus one-point requests to each data endpoint
(about 3 credits live) and stores the result in `AppState.vmc.capabilities`; a working
quotes/latest call is never taken as proof of historical access.

Errors (guide): 401 auth, 402 billing (1003/1004), 403 plan (1006) / key (1005, 1007),
429 rate limits — 1008 per-minute (retry after 60 s), 1011 IP, **1009/1010 daily/monthly
exhaustion (not retried)**, 500 (retried with backoff). Retry-After is honored if sent.

### Estimated credits (assumptions: N assets, eod_quote, 6-month window = ~184 days)

| Activity | Credits |
|---|---|
| Asset sync (map) | 0 |
| Initial daily backfill | 2 × N (184 points/asset, per-asset requests) |
| Weekly refresh (14-day look-back) + baseline | 1 × N per week (baseline itself is local, 0) |
| One-time 72 h hourly backfill | 1 × N |
| Live hourly collection | ⌈N/100⌉ per hour with batches of 100 (⌈N/250⌉ minimum) ≈ 730/month for N ≤ 100 |
| Probe | ~3 |

Example N = 3 (BTC, ETH, LTC): initial ≈ 9, then ≈ 743/month — well inside Basic's 15,000.
Example N = 100: initial ≈ 300, then ≈ 1,160/month. `VMC_MONTHLY_CREDIT_BUDGET` blocks
requests before the local budget is exceeded (sum of `status.credit_count` stored per response).

## 4. Calculations

- **Daily ratio** `r[d] = volume[d] / market_cap[d]` (Decimal, 60-digit precision, stored at
  18 dp, ROUND_HALF_EVEN). Inputs keep their exact JSON digits (reviver with source text).
- **Validity**: invalid when volume or market cap is missing / non-numeric / non-finite /
  negative, or market cap is 0; also when an EOD sample is > `VMC_EOD_MAX_OFFSET_MINUTES`
  after midnight. **Zero volume is valid (ratio 0).** Missing days are never filled.
- **Baseline** `= Σ valid r[d] / valid_day_count` over effective (current-revision) daily rows.
  Not total volume / total cap, not mean volume / mean cap, not weighted.
- **Window**: end = latest completed UTC day (today − 1); start = end − 6 calendar months
  (day clamped to month length) + 1 day; both inclusive. 2026-11-03 → `2026-05-03..2026-11-02`
  (184 days); 2026-09-01 → `2026-03-01..2026-08-31`.
- **Status**: `unavailable` (no valid days), `partial` (asset's `first_historical_data` after
  window start, or coverage < `VMC_MIN_BASELINE_COVERAGE`), else `full`. Each baseline stores
  expected/returned/valid/invalid/missing days, coverage, first/last valid date and reasons.
- **Versioning**: every change in inputs creates `VmcBaseline.version + 1` with
  `VmcBaselineMember` rows (observation id, ratio, included/excluded reason) and
  `formulaVersion`; identical inputs are not duplicated.

## 5. Hourly snapshots

- Bucket policy: `hourBucket` = UTC hour containing the source observation time
  (`last_updated` or the historical quote `timestamp`). `scheduledHour` (job slot) and
  `collectedAt` are stored separately. No exact-hour values are fabricated.
- One effective snapshot per (cmcId, hour) enforced by the `VmcHourlyCurrent` primary key.
  Identical re-delivery = retry (no new row); same observation time with different values =
  `source_revision`; a later observation in the same hour = `newer_observation_in_hour`; an
  older one is ignored (its raw response is still stored). Previous revisions are retained.
- Stale: observation older than `VMC_STALE_AFTER_MINUTES` at collection.
- The comparison distinguishes the **72-hour time window** (expected 72 buckets, missing hours
  listed) from the **latest 72 stored records** (which may span further back when hours are
  missing). Without backfill the window is reported incomplete, never as full history.

## 6. Data flow

```
 VMC_ASSET_IDS ─▶ vmc:sync-assets ── /v1/cryptocurrency/map ─────────▶ VmcAsset (+ metadata change log)
                                                                         │
 weekly ─▶ vmc:daily ── /v3 quotes/historical daily | /v2 ohlcv daily ─▶ VmcRawResponse ─▶ VmcDailyObservation (revisions)
              │                                                             └▶ VmcDailyCurrent (one per day)
              └▶ vmc:baseline (local, decimal) ────────────────────────▶ VmcBaseline vN + VmcBaselineMember
 once  ─▶ vmc:hourly-backfill ── /v3 quotes/historical hourly ─┐
 hourly ─▶ vmc:hourly ── /v3 quotes/latest ────────────────────┴─▶ VmcRawResponse ─▶ VmcHourlySnapshot (revisions)
                                                                                   └▶ VmcHourlyCurrent (one per hour)
 vmc:compare / GET /api/vmc/comparison / dashboard ◀── latest snapshot + 72 h window + latest baseline
 every job ─▶ VmcRun (status, credits) + VmcAssetResult (per asset) ; DB lease "vmc:<job>"
```

## 7. Failure handling

Requests are strictly sequential (concurrency 1) and spaced by `VMC_REQUESTS_PER_MINUTE`
(default 20; Basic allows 50). DB lease per job (no overlap across instances); per-asset outcomes (`ok/partial/failed/skipped`)
so one asset's failure never discards others; run-wide API errors (auth, billing, plan 1006,
credits 1009/1010, local budget) stop remaining assets (marked skipped) instead of repeating;
bounded retries (`VMC_MAX_RETRIES`) with exponential backoff + jitter for 5xx/network, 60 s for
1008; restarts are safe because all writes are idempotent; missing assets in a response are
recorded as failed for that asset.

## 8. Commands

```bash
# Configure (examples are the brief's assets — choose your own universe explicitly)
export VMC_ASSET_IDS=1,1027,2          # Bitcoin, Ethereum, Litecoin
export VMC_SOURCE=fixture              # or: cmc  (needs CMC_API_KEY)
npm run build
npm run cli -- vmc:probe               # live: verify plan/endpoints first
npm run cli -- vmc:run-all             # sync, daily backfill + baseline, 72h backfill, hourly
npm run cli -- vmc:compare             # table; --format json --out var/vmc/comparison.json
VMC_SCHEDULER_ENABLED=true npm start   # hourly + weekly schedules, dashboard section
npm test && npm run test:db            # fixtures only
RUN_LIVE_CMC=1 npm run test:live       # optional, ~2 live credits
```

Synthetic example output: `docs/examples/vmc-comparison.synthetic.txt` / `.json`.

## 9. Limitations and open decisions

- **No CoinMarketCap key configured yet** → only the fixture transport has run; live endpoint
  behavior (exact daily sample times, OHLCV access on Basic) must be confirmed with `vmc:probe`.
- EOD-quote convention approximates "daily volume" with rolling 24 h volume sampled just after
  midnight; OHLCV daily is closer to the website table (p.4) but may require a higher plan.
  The two conventions are stored separately and never mixed in one baseline.
- Hourly backfill depth depends on the plan's intraday history (Basic: 1 month ≥ 72 h).
- Asset classification (stablecoins etc.) is out of scope; the universe is whatever ids you list.
- Open decisions from p.8 remain yours: which assets, which plan, where results are displayed
  beyond the dashboard/CLI/file, and any comparison threshold (none implemented).

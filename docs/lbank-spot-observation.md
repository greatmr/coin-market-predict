# LBank Spot Price Observation

Operator request 2026-11-24. CMC stays the source of the strategy and of 1/2/3-star events; **LBank
Spot** is the source of the entry reference and of every later price. For each CMC star event
detected at or after the cutover, the observation records how far the LBank Spot price rose and fell
over **exactly t0 + 168 h**. Decision record: [ADR-0009](adr/0009-lbank-spot-observation.md). The
legacy [Star Event Forward Test](forward-test.md) keeps its own rules for pre-cutover events and
then retires (§ 9).

> An observation, not a trade: no order, stop loss, take profit, leverage, liquidation, fee,
> funding or realized profit is modelled. _Maximum rise_ and _maximum drop_ are two independent
> price extremes. The Futures label says whether a contract was eligible, not that Spot moves equal
> Futures fills, mark prices or leveraged returns.

## 1. Architecture and cutover points (report A)

| Piece                                                                                                                           | Before                                                                           | After                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Star-event rule (which published Review Queue rows open an event; key `(provider, CMC id, UTC date, stars)`, first insert wins) | inside the legacy module (`forward-rules.ts`, `ForwardCaptureService.queueRows`) | `modules/star-events/` (`validateTrigger`, `PublishedQueueService`), shared unchanged by both trackers                                                      |
| Routing                                                                                                                         | —                                                                                | `signal_cutover` (one UTC-midnight `cutover_at` per provider) + `workflowFor(cutover, detected_at)`; database triggers refuse an event in the wrong tracker |
| Legacy intake (`forward` stage → `ForwardCaptureService.captureBatch`)                                                          | every published batch                                                            | only batches detected **before** the cutover (`forward_event_legacy_intake_guard` refuses the rest)                                                         |
| Legacy daily High update (`forward` stage, `forward:update`, _Update Highs now_)                                                | every closed UTC day                                                             | unchanged for pre-cutover events; stops when the tracker retires (§ 9)                                                                                      |
| New intake (`observe` stage, after `forward`)                                                                                   | —                                                                                | batches detected **at or after** the cutover → `lbank_obs_event` + `lbank_observation` in one transaction                                                   |
| LBank candles, evidence, results                                                                                                | —                                                                                | `lbank-observation` job (own cron `LBANK_OBSERVATION_CRON`, own lease `lbank-observation`), never inside the CMC run                                        |
| Dashboard                                                                                                                       | `/forward`                                                                       | `/lbank-spot` (_LBank Spot observation_); `/forward` labelled legacy and hidden from navigation once retired (still reachable, exports kept)                |

Pipeline: discover → collect → lbank → daily → scan → venues → export → notify → **forward**
(legacy) → **observe** (new intake) → retention. The CMC signal generator, the crawler, daily rows,
the LBank Spot list, venues, exports and Telegram are untouched; no Tier 1 rule changed
(`RULESET_VERSION`, `RANKING_RULESET_VERSION` unchanged).

## 2. Event identity and routing

- **Same rule, new table.** Events of the new tracker live in `lbank_obs_event`, created by the same
  rule as the legacy `forward_event` (`validateTrigger`, same key, `INSERT … ON CONFLICT DO NOTHING`):
  1 → 2 → 3 stars on one UTC date are three events; the same stars again that date are ignored; a new
  UTC date is a new event. The row is the immutable signal snapshot (trigger
  `lbank_obs_event_immutable`): CMC id, t0 (`detected_at` = the batch's crawl time), stars, weighted
  points, VMC fields, the LBank pairs the scanner resolved, and the CMC price **for context only**.
- **One observation per event.** `lbank_observation.event_id` is a unique foreign key
  (`ux_lbank_observation_event`), written in the intake's transaction with its event.
- **The cutover is a UTC midnight.** The event key contains the UTC date, so with `cutover_at` at
  00:00:00.000 UTC no key can straddle the two trackers: a sighting is routed by its detection time
  alone (`workflowFor`, pure). It can be set only ahead (≥ 2 h) of now and of every stored crawl batch
  (`observation:cutover`), so no batch already routed can change tracker; once passed it can never
  change (trigger `signal_cutover_guard`).
- **Database-enforced.** `forward_event_legacy_intake_guard` refuses a legacy event at or after the
  cutover; `lbank_obs_event_intake_guard` refuses a new-tracker event before it (or without a
  cutover). A sighting can go to neither tracker only by failing the shared rule, in which case it
  is recorded with its reasons (legacy: `forward_trigger_rejection`; new: `lbank_obs_intake_run.details`).
- **No missed row.** Every intake run stores `queue_rows = created + ignored + rejected`;
  `observation:check` / `GET /api/observations/routing-check` verify, after the cutover: every
  published batch has an intake run, every row is accounted for, every event has its observation,
  no legacy event after the cutover, no new event before it, no key in both tables. The job also
  re-creates a missing observation (`reconcile`, counted in the run).

## 3. Data source (report B: feasibility, tested 2026-11-24 against real data)

**Chosen: LBank's official public REST API, `GET https://api.lbkex.com/v2/kline.do?type=minute1`.**
The REST history is deep and exact enough that no WebSocket collection or third-party source is
needed.

| Question                           | Evidence (read-only requests, 2026-11-24)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hostname                           | LBank's notice "LBank API Update" (support article 21533217989145, 2023-08-07): the request address is `https://api.lbkex.com`; `api.lbank.info` "no longer in use". The docs page (lbank.com/docs/index.html) still shows `api.lbank.info`. All three hosts answered with identical data; `api.lbkex.com` was the steadiest (median 1.8 s, max 2.7 s; `www.lbkex.net` up to 11.5 s and once a non-JSON reply; `api.lbank.info` up to 17.3 s). Configurable: `LBANK_API_BASE_URL`.                                               |
| 1-minute history                   | `btc_usdt` minute bars served back to 2020-01-20 (oldest probed); `0g_usdt` back to its first trade (2025-09-22 09:59Z). 255 of the 259 coins with production events serve their first bar (listing evidence).                                                                                                                                                                                                                                                                                                                   |
| Full 168 h windows                 | 7 real events (0G, DYDX, MANTA, KNTQ, TIT, ORBIO, plus BTC checks): each window took 6 requests (5 × 2000 + 1), about 22 s; 10 079 of 10 079 full bars, 0 time gaps, 0 duplicates, ascending.                                                                                                                                                                                                                                                                                                                                    |
| `time` / `size` semantics          | `time` is a Unix second; the first bar returned is the one **containing** it (tested at B−1, B, B+1, B+30, B+59, B+60 s). `size` 1–2000; 0, 2001 or 2500 → `error_code` 10003 _Illegal parameter_ with HTTP 200. Bar times are whole UTC minutes; day bars open at 16:00 UTC (UTC+8), not used.                                                                                                                                                                                                                                  |
| Before listing                     | A `time` before the pair's first trade returns the pair's **first bars** (no error): minutes before the first returned bar are recorded as answered without a bar.                                                                                                                                                                                                                                                                                                                                                               |
| The current minute                 | The last bar returned can be the minute in progress (its High / Low / Close / Volume change); a bar is stored only when `open + 60 s + 5 s ≤` the response's server time `ts`. A closed bar was final 1.2 s after its close and identical on every later read.                                                                                                                                                                                                                                                                   |
| Restatements                       | 40 556 closed bars of 4 windows re-fetched 44 minutes later: 0 differences. Stored bars are immutable (trigger).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| High / Low are LBank Spot trades   | Compared with `GET /v2/supplement/trades.do` (millisecond trade times): in every traded minute checked, HIGH = highest trade, LOW = lowest trade, CLOSE = last trade of that pair. **OPEN is the previous bar's CLOSE** (10 078 of 10 078 consecutive bars), i.e. the last traded price when the bar opens — it can lie outside [LOW, HIGH] (9 and 3 bars in two windows).                                                                                                                                                       |
| Sparse trading                     | Minutes without trades are filled: O = H = L = C = previous close, volume 0 (`tit_usdt`: 4 303 of 4 320 minutes in 3 days; its event window: 136 traded bars of 10 079). Such bars are never extremes (§ 5).                                                                                                                                                                                                                                                                                                                     |
| Delisted / unknown pairs           | `error_code` 10008 _currency pair nonsupport_ (HTTP 200) on klines and pair info, and absent from `GET /v2/currencyPairs.do` (1 366 pairs). 4 of 259 event coins' CMC-listed USDT pairs (BULLA 18 events, SHARE, JSM, SNC) now answer 10008: their history is no longer retrievable.                                                                                                                                                                                                                                             |
| Rate limit, errors                 | Headers `X-LBank-RateLimit-Limit: 200`, `X-LBank-RateLimit-Time: 10s` (the documented 200 requests / 10 s); 40 requests at 10/s: all answered. Error 10004 _Request too frequent_ → treated as HTTP 429 (backoff, Retry-After), 10000 internal → 503 (retried); the polite client adds a circuit breaker and a monthly budget under provider `lbank_spot`.                                                                                                                                                                       |
| Volume at our scale                | Production (dump 2026-11-24 12:26Z): 2 331 events on 259 coins since 2026-11-10, 58–302 a day; 222–242 coins have an open window at once. Shared per-pair candles are 22.5 % of per-event storage (5.28 M vs 23.5 M minute bars in 14 days). Ongoing: about one request per active pair per hour (≈ 225 / h, 0.3 % of LBank's limit); a new window needs at most 6 requests. No backfill: only events at or after the cutover are observed.                                                                                      |
| Listing status at the signal       | Spot: candles are historical evidence (bars before and at t0 show the pair existed and traded then); `currencyPairs.do` is current-only, so it is fetched at the signal. Futures: LBank's public contract API (`lbkperp.lbank.com/cfd/openApi/v1/pub/instrument`, `…/marketData`) has no history and no klines, so a past status cannot be reconstructed from LBank: evidence before t0 is CMC's LBank Futures list (stored daily since 2026-11-17), evidence after t0 is LBank's own contract list fetched at the signal (§ 4). |
| CMC vs LBank (sanity, never mixed) | Entry vs CMC price at detection: −0.91 % … +0.4 % on tested events. Peak rise LBank vs legacy CMC: 0G +13.73 % vs +13.89 % (peak minute 11:25 vs 11:26), DYDX +4.88 % vs +4.86 %, MANTA +1.23 % vs +1.06 %, ORBIO +8.21 % vs +6.79 %, KNTQ +6.15 % vs +2.43 % (an LBank-only spike), TIT +120 % vs +104 % (illiquid).                                                                                                                                                                                                            |

Not used: the documented Spot WebSocket (`wss://api.lbkex.com/ws/V2/`, kbar) would only collect from
the moment it connects and is unnecessary while REST serves years of history with gap recovery by
re-request; TradingView (a chart widget, not a data API); CMC prices, 24 h tickers, daily candles or
other exchanges (never used for an LBank High or Low).

## 4. Pair and eligibility at the signal

**Pair** (`resolveSpotPair`): the LBank Spot pairs the scanner resolved for the event's **CMC id**
(CMC's LBank Spot markets list; never by ticker). Exactly one **USDT** pair is required; its LBank
symbol is read from CMC's market URL for that very market (`…/trade/0g_usdt/`), so a reused ticker
cannot substitute another asset. No USDT pair → `NO_USDT_PAIR` (_Spot unavailable_, 0 of 259 coins
today); several, or no verifiable symbol → _Mapping ambiguous_. Identity check only: an LBank entry
deviating more than 25 % from the CMC price at detection makes the mapping uncertain
(`PRICE_DEVIATION_FROM_CMC`); the CMC price never enters a return.

**Spot** (`spotAtSignal`): YES when the LBank series spans t0 (a bar in the hour before and the entry
bar) and LBank's pair list fetched within 2 h of t0 does not contradict it; NO when LBank answered
10008 within 2 h of t0, or its list lacked the pair and no bar exists before t0; otherwise UNKNOWN.
_Trading_: a bar with trades within ±1 h of t0 (`TRADES_OBSERVED`), else `NO_RECENT_TRADES`.

**Futures** (`futuresAtSignal`): evidence before t0 (CMC's LBank Futures list, latest complete list
fetched at or before t0 and ≤ `EXCHANGE_LISTS_MAX_AGE_HOURS` old, by CMC id) and right after t0
(LBank's own contract list with 24 h volume, fetched within 2 h of t0) must agree: YES only when the
CMC-listed contract is in LBank's list with volume > 0; NO only when neither list has it (and LBank
has no contract on the coin's ticker); everything else UNKNOWN with its reason. A listing today never
answers for an earlier signal.

| Class                            | Rule                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| Spot + Futures eligible          | Spot YES, Futures YES                                      |
| Spot only                        | Spot YES, Futures NO                                       |
| Spot available / Futures unknown | Spot YES, Futures UNKNOWN                                  |
| Spot unavailable                 | Spot NO, or no USDT pair                                   |
| Spot unknown                     | Spot UNKNOWN (status ELIGIBILITY_UNKNOWN when it stays so) |
| Mapping ambiguous                | several pairs, unverifiable symbol, or price deviation     |

The three Spot-available classes are measured from LBank Spot prices.

## 5. Window, entry and extremes

```
t0            = the event's CMC signal time (immutable)
cutoff        = t0 + 168 h exactly (no extension to the end of a UTC day)
entry bar     = the first 1-minute bar opening at or after t0   (never one opened before t0)
entry price   = its OPEN = LBank's last traded price at that instant
valid bars    = bars with trades, opening at or after the entry bar and ending by the cutoff
max rise %    = 100 × (highest High / entry − 1)
max drop %    = 100 × (lowest Low / entry − 1)       (negative for a decline)
```

- **Entry delay** = entry bar open − t0, ≤ 60 s with contiguous bars (15–60 s on every tested
  event). Maximum accepted: **2 minutes** (one missing bar); later → `ENTRY_TOO_LATE`, never shown as
  an entry at t0. Both t0 and the entry time are stored with the delay.
- **Stale entry**: no bar with trades in the hour before the entry bar → `ENTRY_STALE` (the entry is
  an old last trade); such an observation ends PARTIAL, not FINAL.
- **Boundary**: [t0, entry bar) and [floor(cutoff), cutoff) are not observed by any bar; the bar that
  straddles the cutoff is never used (no finer timestamped data is read). Stored per observation as
  `start_unobserved_ms` and `boundary_unobserved_ms` (78 ms for a t0 of hh:07:00.078).
- **Valid bars**: filled bars (no trades) carry the previous close, possibly a pre-entry price, so
  they are never extremes. Ties go to the earliest bar. 10 080 bars when t0 is on a whole minute,
  else 10 079.
- **Order**: by bar time (`HIGH_FIRST` / `LOW_FIRST`); a High and Low in the same minute are
  `SAME_BAR` (order unknown: trade times are not used).
- **Lowest Low before the High** (descriptive, labelled so): the lowest Low from the entry bar up to
  and including the bar of the eventual highest High.
- Exact decimals throughout (prices stored with the API's own digits in unconstrained `numeric`).

## 6. Statuses

| Status              | When                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACTIVE              | the window runs or its last bars / gaps / evidence are still being fetched (provisional values)                                                         |
| FINAL               | t0 + 168 h passed, every expected bar present, fresh entry, Spot YES, at least one trade                                                                |
| PARTIAL             | window over and retries done (24 h), with missing bars, a stale entry, no trade, or an incomplete fetch; values stay visible, never in final statistics |
| DATA_UNAVAILABLE    | no LBank data for the signal: pair unsupported (10008), no USDT pair, entry missing or too late, Spot not listed at the signal                          |
| MAPPING_AMBIGUOUS   | the LBank pair cannot be pinned to the CMC id                                                                                                           |
| ELIGIBILITY_UNKNOWN | Spot availability at the signal still unknown after the retries                                                                                         |

A terminal status sets `finalized_at`, writes the append-only `lbank_observation_result` (with the
SHA-256 of the exact bars used) and freezes the observation (trigger `lbank_observation_frozen`).
Reasons are stable codes (`observation.constants.ts`, `OBS_REASON`). Rules version
`lbank-spot-obs-1` on every observation and result.

## 7. Collection job and storage

Every `LBANK_OBSERVATION_CRON` (15 min) under its own lease: (1) reconcile events without an
observation; (2) for new observations, fetch LBank's Spot pair and Futures contract lists once and
store each observation's extract with the CMC Futures list as of t0; (3) per pair, fetch the
missing minutes from one hour before the earliest entry still needed (at most every
`LBANK_SYNC_INTERVAL_MINUTES`, sooner while an entry is pending or a window needs its last bars;
≤ 8 pages per pair per run; `LBANK_OBSERVATION_MAX_MINUTES` per run); (4) re-request known gaps (two
per pair per run); (5) recompute every unfinished observation of the pair from the shared bars;
(6) delete candles older than `LBANK_CANDLE_RETENTION_DAYS` (7) that no unfinished observation needs.

| Table                      | Content                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `signal_cutover`           | the cutover per provider (UTC midnight; immutable once passed)                             |
| `lbank_obs_intake_run`     | each reading of a published queue: created / ignored / rejected with reasons               |
| `lbank_obs_event`          | immutable CMC star events at or after the cutover (same key as the legacy rule)            |
| `lbank_spot_pair`          | LBank pairs: first bar (listing evidence), `synced_until`, last fetch, `unsupported_since` |
| `lbank_spot_candle`        | shared closed 1-minute bars per (pair, minute), exact digits, immutable                    |
| `lbank_market_list_fetch`  | each fetch of LBank's pair / contract list (time, count, hash)                             |
| `lbank_observation`        | one per event: pair, eligibility + evidence, entry, extremes, coverage, status             |
| `lbank_observation_result` | terminal results, append-only                                                              |
| `lbank_obs_run`            | job runs: counts, notes, errors                                                            |

Sizing: ≈ 225 active pairs × 1 440 bars a day ≈ 325 k rows (≈ 35 MB) a day; with the default 7-day
retention about 2.3–2.6 M rows (≈ 300 MB) at steady state. `0` keeps every candle.

## 8. Surfaces

| Surface   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard | **LBank Spot observation** (`/lbank-spot`): summary (cutover, final-only statistics with their denominators in events and coins, provisional and unmeasured counts, correlation), filters (search, status, Spot / Futures class, coverage complete / missing, signal date from / to, stars), sortable table (coin, stars, points, CMC signal time, LBank pair, class, entry + delay, max rise, max drop, High / Low with bar times and order, status, coverage, same-coin overlaps), CSV export, _Update now_                      |
| API       | `GET /api/observations` (filters `status`, `eligibility`, `stars`, `coverage`, `from`, `to`, `search`, `sort`, `dir`, `limit`, `offset`), `GET /api/observations/summary`, `GET /api/observations/:id` (with evidence and result versions), `GET /api/observations/runs`, `GET /api/observations/routing-check` (`health:read`), `GET /api/observations/export.csv` (`exports:read`), `POST /api/observations/update` (`scan:operate`); legacy: `GET /api/forward/legacy`, `GET /api/forward/legacy/closures.csv` (`exports:read`) |
| CLI       | `observation:cutover [--at ISO] [--note]`, `observation:status`, `observation:update`, `observation:probe`, `observation:list`, `observation:check`, `forward:legacy`                                                                                                                                                                                                                                                                                                                                                              |

## 9. Legacy wind-down

Pre-cutover events keep their own rules and daily High update until each has an explicit terminal
outcome (`legacy-closure.ts`, `forward_legacy_closure`): **FINAL** (status FINAL), **INCOMPLETE** (the
window closed and the missing-data retries — `MISSING_DATA_RETRY_DAYS` = 3 days after
`evaluation_end` — are over, with a confirmed lower-bound peak) or **DATA_UNAVAILABLE** (retries
over, no confirmed High, or the last check failed), with reasons. Once the cutover has passed and
every legacy event is terminal, the daily update writes the retirement report (counts per outcome and
reason codes) to `app_state` (`forward.legacy.retirement.<provider>`) and from then on: no daily High
update (hourly, CLI or button), the page leaves the navigation (still at `/forward`), exports stay
available. Nothing is deleted or rewritten. With a cutover at day D the last legacy event becomes
terminal by about D + 11 days (`forward:legacy` shows the date).

## 10. Cutover runbook (plan C)

Preconditions: this change deployed (migration M015 runs at container start), `observation:check`
green, one fixture run reviewed locally. Production:

```bash
ssh jahantalab && cd /root/jahan/market-predict
alias dc='docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod'
dc exec -T postgres pg_dump -U coins -Fc coins > ~/coins-pre-m015-$(date +%F).dump    # backup
git pull && dc up -d --build                    # M015; legacy flow unchanged (no cutover yet)
dc exec api node dist/cli.js db:status          # M015 applied
dc exec api node dist/cli.js observation:probe  # LBank reachable from the server (read-only, ~4 requests)
dc exec api node dist/cli.js observation:cutover --at 2026-11-26T00:00:00Z --note "go-live"
dc exec api node dist/cli.js observation:cutover   # shows the stored cutover
```

**Checks after the first hourly run past the cutover:** `observation:check` → `ok: true`
(`batchesAfterCutover ≥ 1`, 0 batches without intake, 0 unaccounted rows, 0 legacy events after the
cutover, 0 keys in both trackers, 0 events without observation); `observation:status` shows the new
events; after ≤ 15 min their entries; `forward:legacy` shows `closing` with the pending count.

**Duplicate prevention**: one key per table (unique), one observation per event (unique foreign
key), the UTC-midnight cutover (no key in both tables), and the two intake guards.

**No missed event**: the totality of `workflowFor` (every sighting goes to exactly one side), the
`queue_rows = created + ignored + rejected` ledger per batch, the per-batch intake check above, and
`reconcile` for events without observation.

**Rollback** (before the cutover): redeploy the previous image; M015 only adds tables and triggers,
and its guard on `forward_event` does nothing while no cutover row exists — leave it in place.
**After the cutover**: do not move or delete it (the database refuses). To stop the new tracker
temporarily set `LBANK_OBSERVATION_ENABLED=false` (events are still recorded by the `observe`
stage; the job catches up later — candles are historical). A full rollback to the legacy tracker for
post-cutover events is not possible without deleting `signal_cutover` with the guard disabled and
re-running `forward:update`: an explicit, manual decision; never `db:revert` on real data.

## 11. Limitations

| Id  | Limitation                                      | Effect                                                                                                                                                                       |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | No historical LBank Futures status              | Futures YES/NO only from agreeing lists before and after t0; otherwise UNKNOWN                                                                                               |
| L2  | A delisted pair loses its LBank history (10008) | events of such pairs are DATA_UNAVAILABLE; bars stored before delisting remain                                                                                               |
| L3  | OPEN is the previous CLOSE                      | the entry is the last traded price at the entry bar's opening instant                                                                                                        |
| L4  | Minute bars only                                | the minutes at both ends of the window are unobserved (stored); same-minute High/Low order unknown                                                                           |
| L5  | Evidence lists fetched by the job               | if the job is down more than 2 h after a signal, its list evidence is missing (Spot falls back to candles; Futures stays UNKNOWN)                                            |
| L6  | Candle retention                                | after `LBANK_CANDLE_RETENTION_DAYS` the raw bars of finished windows are deleted (results and their series hash stay; LBank re-serves the history except for delisted pairs) |

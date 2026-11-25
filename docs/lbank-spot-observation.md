# LBank Spot Price Observation

Operator request 2026-11-24, corrected 2026-11-25 (rules **`lbank-spot-obs-2`**,
[ADR-0010](adr/0010-lbank-observation-v2.md)). CMC stays the source of the strategy and of 1/2/3-star
events; **LBank Spot** is the source of the reference price and of every later price. For each CMC
star event detected at or after the cutover, the observation records the first LBank Spot trade after
the signal became usable and how far the LBank Spot price rose and fell over **exactly
`[start, start + 168 h)`**. Decision records: [ADR-0009](adr/0009-lbank-spot-observation.md) (the
tracker), [ADR-0010](adr/0010-lbank-observation-v2.md) (rules v2). The legacy
[Star Event Forward Test](forward-test.md) keeps its own rules for pre-cutover events and then
retires (§ 9).

> An observation, not a trade: no order, stop loss, take profit, leverage, liquidation, fee,
> funding or realized profit is modelled. The _reference price_ is an observed trade, not a claim
> that an order could have been filled at that price or size. _Maximum rise_ and _maximum decline_
> are two independent price extremes, never summed. Futures is listing evidence from snapshots, never
> a Futures price, fill or leveraged return.

## 1. Architecture and cutover points

| Piece                                                                                                                           | Before                                                                           | After                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Star-event rule (which published Review Queue rows open an event; key `(provider, CMC id, UTC date, stars)`, first insert wins) | inside the legacy module (`forward-rules.ts`, `ForwardCaptureService.queueRows`) | `modules/star-events/` (`validateTrigger`, `PublishedQueueService`), shared unchanged by both trackers                                                      |
| Routing                                                                                                                         | —                                                                                | `signal_cutover` (one UTC-midnight `cutover_at` per provider) + `workflowFor(cutover, detected_at)`; database triggers refuse an event in the wrong tracker |
| Legacy intake (`forward` stage → `ForwardCaptureService.captureBatch`)                                                          | every published batch                                                            | only batches detected **before** the cutover (`forward_event_legacy_intake_guard` refuses the rest)                                                         |
| Legacy daily High update (`forward` stage, `forward:update`, _Update Highs now_)                                                | every closed UTC day                                                             | unchanged for pre-cutover events; stops when the tracker retires (§ 9)                                                                                      |
| New intake (`observe` stage, after `forward`)                                                                                   | —                                                                                | batches detected **at or after** the cutover → `lbank_obs_event` + `lbank_observation` in one transaction, with the proven start (§ 2a)                     |
| LBank candles, trades, evidence, results                                                                                        | —                                                                                | `lbank-observation` job (own cron `LBANK_OBSERVATION_CRON`, own lease `lbank-observation`), never inside the CMC run                                        |
| Dashboard                                                                                                                       | `/forward`                                                                       | `/lbank-spot` (_LBank Spot price observation_); `/forward` labelled legacy and hidden from navigation once retired (still reachable, exports kept)          |

Pipeline: discover → collect → lbank → daily → scan → venues → export → notify → **forward**
(legacy) → **observe** (new intake) → retention. The CMC signal generator, the crawler, daily rows,
the LBank Spot list, venues, exports and Telegram are untouched; no Tier 1 rule changed
(`RULESET_VERSION`, `RANKING_RULESET_VERSION` unchanged).

## 2. Event identity and routing

- **Same rule, new table.** Events of the new tracker live in `lbank_obs_event`, created by the same
  rule as the legacy `forward_event` (`validateTrigger`, same key, `INSERT … ON CONFLICT DO NOTHING`):
  a star count not yet seen on that UTC date opens an event **whether it is higher or lower**
  (1 → 3 → 2 are three events); the same count again that date is ignored; a new UTC date is a new
  event. The row is the immutable signal snapshot (trigger `lbank_obs_event_immutable`): CMC id, the
  crawl time `detected_at` (t0), the CMC quote time, stars, weighted points, VMC fields, the LBank
  pairs the scanner resolved, and the CMC price **for context only**.
- **The crawl time names the event; it never starts the window.** The key's UTC date and the routing
  use t0, exactly as before the v2 rules; the window starts at the proven publication (§ 2a). A row
  crawled at 23:07 and published after midnight keeps its crawl date and its tracker.
- **One observation per event.** `lbank_observation.event_id` is a unique foreign key
  (`ux_lbank_observation_event`), written in the intake's transaction with its event.
- **The cutover is a UTC midnight.** The event key contains the UTC date, so with `cutover_at` at
  00:00:00.000 UTC no key can straddle the two trackers: a sighting is routed by its crawl time alone
  (`workflowFor`, pure). It can be set only ahead (≥ 2 h) of now and of every stored crawl batch
  (`observation:cutover`), so no batch already routed can change tracker; once passed it can never
  change (trigger `signal_cutover_guard`).
- **Database-enforced.** `forward_event_legacy_intake_guard` refuses a legacy event at or after the
  cutover; `lbank_obs_event_intake_guard` refuses a new-tracker event before it (or without a
  cutover). A sighting can go to neither tracker only by failing the shared rule, in which case it
  is recorded with its reasons (legacy: `forward_trigger_rejection`; new: `lbank_obs_intake_run.details`).
- **No missed row.** Every intake run stores `queue_rows = created + ignored + rejected`;
  `observation:check` / `GET /api/observations/routing-check` verify, after the cutover: every
  published batch has an intake run, every row is accounted for, every event has its observation,
  no legacy event after the cutover, no new event before it, no key in both tables (and reports
  observations still without a start). The job also re-creates a missing observation (`reconcile`).

## 2a. When the window starts (rules v2)

Traced on all 13 production batches of 2026-11-25 (server records): the crawl starts at t0
(hh:07:00.05); the scan writes the batch's Review Queue rows and `scan_run.status = succeeded` in one
transaction; `/api/scan` serves the newest succeeded scan, so the dashboard shows the row from that
commit (3.1 s – 8 min 32 s after t0; the 00:07 run refreshes the new day's daily rows first); the
observe stage commits the event later (5.4 s – 10 min 47 s); Telegram follows the export.

| Start source (`actionable_source`) | When it applies                                    | Proof                                                                                                                 |
| ---------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `SCAN_COMMIT`                      | the event's pipeline run recorded its scan stage   | `pipeline_stage(scan).finished_at`, written right after the publishing transaction committed (≈ 4 ms after it)       |
| `EVENT_COMMIT` (uncertain)         | no scan record (an intake outside a pipeline run)  | a time read right after the intake committed (or the observe stage's finish): the LBank Spot page could show the event |
| `JOB_FIRST_SEEN` (uncertain)       | neither recorded                                   | the first observation run that read the event                                                                          |

`observation_start = actionable_at`, `observation_end = observation_start + 168 h` (a database
check), never before t0 (a database check). The evidence (`actionable_evidence`) keeps the crawl and
quote times, the scan stage and scan run records, the intake time and the bounds of the usable
moment. The 85 observations open when v2 shipped got `SCAN_COMMIT` from their stored stage rows.

## 3. Data sources (tested against real data)

**LBank's official public REST API** (`api.lbkex.com`), provider `lbank_spot`, through the polite
client (rate limit `LBANK_REQUESTS_PER_MINUTE`, monthly budget, circuit breaker).

| Endpoint / question               | Evidence                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v2/kline.do?type=minute1`       | `time` in Unix **seconds**, size 1–2000; the first bar is the one containing `time`; years of history. A bar is stored only once closed (`open + 60 s + 5 s ≤` the response's `ts`); closed bars never changed on re-reads. Before listing: the pair's first bars. Delisted / unknown: error 10008.                                         |
| What a candle is                  | **OPEN = the previous CLOSE** (34 645/34 645 bars): never a trade in the minute. **High / Low may be that carried OPEN** without any trade at that price (30 Highs and 24 Lows of 180 traded minutes on all 60 production pairs, 2026-11-25). Minutes without trades are filled (O = H = L = C = previous close, volume 0). |
| `/v2/supplement/trades.do`        | `time` in **milliseconds**, returns trades **strictly after** `time` (tested: `time = T − 1` includes a trade at T, `time = T` does not), ascending, 1–600 per page (601 and 1000 → 10003); a future `time` → 10003; unknown pair → 10008. Each trade: id (UUID-like, not ordered), ms time, exact price and quantity, side. ≥ 365 days of history. |
| Same millisecond                  | Several trades can share one ms (e.g. a sweep); LBank's order inside it is the same on every request.                                                                                                                                                                                                                                          |
| Trades vs candle                  | Over 542 checked minutes (180 probe + 362 on the production copy) no trade lay outside its candle's [Low, High]; trade quantity equalled the candle volume in 167 of the 180 probe minutes and exceeded it (by one in-range trade the candle missed) in 13; never fewer.                                                                                          |
| `/v2/currencyPairs.do`            | LBank's current Spot pairs (Spot evidence near the signal).                                                                                                                                                                                                                                                                                    |
| `lbkperp.lbank.com/cfd/openApi/v1/pub/instrument`, `…/marketData` | LBank Futures contracts and 24 h volume, current only (no history).                                                                                                                                                                             |
| Rate limit, errors                | `X-LBank-RateLimit-Limit: 200` per 10 s; 10004 → treated as HTTP 429 (backoff), 10000 → 503 (retried).                                                                                                                                                                                                                                        |

Not used: the WebSocket (collects only from connection time), TradingView (a chart widget), CMC
prices or other exchanges (never an LBank price).

## 4. Pair and evidence at the signal

**Pair** (`resolveSpotPair`): the LBank Spot pairs the scanner resolved for the event's **CMC id**
(CMC's LBank Spot markets list; never by ticker). Exactly one **USDT** pair is required; its LBank
symbol is read from CMC's market URL for that very market (`…/trade/0g_usdt/`), so a reused ticker
cannot substitute another asset. No USDT pair → `NO_USDT_PAIR` (_Spot unavailable_); several, or no
verifiable symbol → _Mapping ambiguous_. The candidates and the time of CMC's list behind the mapping
are kept as evidence. **Review flags, not exclusions:** a reference more than 25 % away from the CMC
price at detection (`PRICE_DEVIATION_FROM_CMC`) and a mapping list older than
`LBANK_PAIRS_REFRESH_DAYS` at the signal (`MAPPING_SNAPSHOT_OLD`). The CMC price never enters a
return, and no other exchange's price replaces missing Spot evidence.

**Spot** (`spotAtSignal`): YES when LBank's candles span the start (a candle in the hour before the
start minute and one at it) and LBank's pair list read within 2 h of t0 does not contradict it; NO
when LBank answered 10008 within 2 h of t0, or its list lacked the pair and no candle exists before;
otherwise UNKNOWN. _Trading_: a traded candle within ±1 h of the start (evidence only).

**Futures** (`futuresAtSignal`) — **listing evidence from two snapshots**, never proof that a contract
was tradable at the signal instant: before t0, CMC's LBank Futures list (latest complete list
fetched at or before t0, ≤ `EXCHANGE_LISTS_MAX_AGE_HOURS` old, by CMC id); after t0, LBank's own
contract list with 24 h volume (read within 2 h of t0). YES = listed in both; NO = in neither (and no
LBank contract on the coin's ticker); otherwise UNKNOWN with its reason. Both snapshot times are
shown. A listing today never answers for an earlier signal; Futures never blocks a Spot result.

| Class (label)                              | Rule                                                       |
| ------------------------------------------ | ---------------------------------------------------------- |
| Spot · Futures listed (snapshots)          | Spot YES, Futures YES                                      |
| Spot · Futures not listed (snapshots)      | Spot YES, Futures NO                                       |
| Spot · Futures unknown                     | Spot YES, Futures UNKNOWN                                  |
| Spot unavailable                           | Spot NO, or no USDT pair                                   |
| Spot unknown                               | Spot UNKNOWN (status ELIGIBILITY_UNKNOWN when it stays so) |
| Mapping ambiguous                          | several pairs or an unverifiable symbol                    |

## 5. Window, reference and extremes (rules v2)

```
start          = observation_start (§ 2a; never the crawl time)
end            = start + 168 h exactly; the window is [start, end)
reference      = the first verified LBank Spot trade with start ≤ time < end
highest        = the highest verified trade in [reference, end)       (first one at that price)
lowest         = the lowest verified trade in [reference, end)        (first one at that price)
max rise %     = 100 × (highest / reference − 1)   ≥ 0
max decline %  = 100 × (lowest / reference − 1)    ≤ 0
```

- **Checked minute.** A minute's complete trade list: read from `time = m − 1`, each next page from
  `last.time − 1`, de-duplicated by trade id; a page that brings no new id (more than 600 trades in one
  millisecond) or the page cap (60 pages) stops as `PAGING_INCOMPLETE`, never an endless loop. It is
  **verified** when every page was read and the trade quantity is at least the candle volume
  (operator decision 2026-11-25; a surplus is the candle's undercount and is stored); fewer trades
  than the candle is `TRADES_BELOW_CANDLE`. Failed, timed-out or rate-limited requests are
  `FETCH_FAILED`; a delisted pair `PAIR_UNSUPPORTED`. Every unverified outcome is retried.
- **Reference.** Minutes are walked from the start minute: a zero-volume candle is a verified quiet
  minute; a traded minute is checked and its first trade with `time ≥ start` (and `< end`) is the
  reference — inclusive at the start. A missing candle or an unverified minute stops the search; it
  is never skipped, so no earlier post-start trade can be missed. Stored: trade id, ms time, price,
  quantity, delay from the start. Several trades in its millisecond: LBank's (stable) order picks
  the first; a different price among them is flagged `REFERENCE_SAME_MS_TIE`.
- **Delayed** (operator rule): at least one whole minute after the start was verified without a
  trade before the reference. The delay is always shown; nothing is excluded or shifted: the window
  still ends at `start + 168 h`.
- **Extremes.** Candles only point to candidates: a candle's High (Low) bounds its minute's trades
  (empirically, § 3), so whole minutes are taken in High (Low) order and checked one by one until no
  remaining candle could hold a higher (lower) price or an equal one earlier — a High that was only
  the carried OPEN is passed over once its trades show it. The reference's own minute (trades at or
  after the reference) and the last partial minute (trades before `end`) come from trades only.
  Ties go to the earliest trade. **Proven** (`extremes_proven`) means for the whole window, so it
  stays false while the window runs; until then the values are exact up to the data freshness
  (`data_through`) whenever no candidate minute awaits a check (`VERIFICATION_PENDING`), and the
  detail view says which of the two holds.
- **Order.** By the extremes' trade times; different trades in one millisecond: `SAME_MS` (unknown).
- **Lowest up to the highest** (descriptive, labelled so): the lowest verified trade from the
  reference through the highest trade, by the same method.
- **Thin-market flag** (operator rule): the highest or lowest price was set in a minute with exactly
  one trade (`SINGLE_TRADE_HIGH` / `SINGLE_TRADE_LOW`); the evidence holds that trade's quantity and
  USDT value, the minute volume and the trades just before and after it. Flagged events stay in every
  count and statistic.
- Exact decimals throughout (prices with the API's own digits in unconstrained `numeric`).

## 6. Statuses, gaps and retries

| Status              | When                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACTIVE              | the window runs, or data is still being fetched or verified (values provisional)                                                                                                        |
| FINAL               | the window is over, the reference and every deciding minute verified, every minute of `[start, end)` has a candle, Spot YES                                                              |
| NO_TRADES           | every minute of the window verified and nothing traded (no percentage exists)                                                                                                           |
| PARTIAL             | window over and retries done; the reference is verified but minutes are missing or a deciding minute stayed unverified: values over the covered part, exact gaps listed, never in statistics |
| UNVERIFIABLE        | retries done and no first trade after the start could be proven                                                                                                                          |
| DATA_UNAVAILABLE    | no LBank data for the signal: pair unsupported (10008), no USDT pair, Spot not listed at the signal                                                                                      |
| MAPPING_AMBIGUOUS   | the LBank pair cannot be pinned to the CMC id                                                                                                                                            |
| ELIGIBILITY_UNKNOWN | Spot availability at the signal still unknown after the retries                                                                                                                         |

**Gap states** (`gaps`, with exact ranges): `NO_BAR` (LBank answered without a candle; completeness
not established), `FETCH_FAILED` (request failed, timed out or rate-limited), `NOT_FETCHED`,
`PAIR_UNSUPPORTED`, `TRADES_UNVERIFIED` (a needed minute's trades not verified, with the reason). A
zero-volume candle is not a gap: it is a verified minute without trades. An unavailable source is
never read as a quiet market.

**One retry policy** (`FINALIZE_RETRY_MS`): every gap — the first minutes included — is retried on
every run until `end + 24 h` (`retry_until`); then the status is terminal. Candle gaps: two
re-requests per pair per run; trade checks: up to 40 minutes per pair per run within
`LBANK_OBSERVATION_MAX_MINUTES`.

A terminal status sets `finalized_at`, writes the append-only `lbank_observation_result` (rules
version, all v2 values, the evidence and the SHA-256 of the candles and trades it rests on) and freezes
the observation (trigger `lbank_observation_frozen`). Reasons are stable codes (`OBS_REASON`).

## 7. Collection job, storage and retention

Every `LBANK_OBSERVATION_CRON` (15 min) under its own lease: (1) reconcile events without an
observation; (2) move rows of older rules to the current rules (audit row first, § 12); (3) establish
missing starts from the server records (§ 2a); (4) for new observations, read LBank's Spot pair and
Futures contract lists once and store each one's extract with CMC's Futures list as of t0; (5) per
pair, fetch the missing candles from one hour before the earliest start still needed (at most every
`LBANK_SYNC_INTERVAL_MINUTES`, every run while a reference is pending or a window needs its last
candles; ≤ 8 pages per pair per run) and re-request known gaps; (6) check the trades of the minutes
the rules ask for, in rounds (a carried-OPEN artefact leads to the next candidate), shared by the
pair's observations; (7) recompute every unfinished observation and freeze terminal results; (8)
archive and prune old candles. The run report says whether it fetched new data or only recomputed.

| Table                       | Content                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `signal_cutover`            | the cutover per provider (UTC midnight; immutable once passed)                                                           |
| `lbank_obs_intake_run`      | each reading of a published queue: created / ignored / rejected with reasons                                              |
| `lbank_obs_event`           | immutable CMC star events at or after the cutover (same key as the legacy rule)                                          |
| `lbank_spot_pair`           | LBank pairs: first bar, `synced_until`, last attempt / last success for candles and trades, `unsupported_since`           |
| `lbank_spot_candle`         | shared closed 1-minute candles per (pair, minute), exact digits, immutable                                               |
| `lbank_spot_trade`          | trades of checked minutes per (pair, trade id), ms time, LBank's same-ms order, exact price / qty, immutable              |
| `lbank_spot_trade_minute`   | each checked minute: status, trade count, quantity vs candle volume, pages, response hashes, attempts (immutable once verified) |
| `lbank_spot_candle_archive` | per (pair, UTC day): gzip of the exact candle CSV, its SHA-256, counts (immutable)                                         |
| `lbank_market_list_fetch`   | each read of LBank's pair / contract list (time, count, hash)                                                            |
| `lbank_observation`         | one per event: pair, evidence, start and its proof, reference, extremes, flags, coverage, gaps, freshness, status; rules-v1 columns as audit |
| `lbank_observation_result`  | terminal results per version and rules version, append-only                                                              |
| `lbank_obs_rules_change`    | the audit trail of every move to new rules (previous values, status, result version), append-only                        |
| `lbank_obs_run`             | job runs: counts (incl. fetched vs recomputed), notes, errors                                                             |

**Retention** (`LBANK_CANDLE_RETENTION_DAYS`, 7 on production): raw candles older than that, which
no unfinished observation needs (its look-back hour through its window end), are archived per pair
and UTC day and then deleted, whole days only; a day whose raw candles are not all in its archive is
kept raw. Archives and trades are never deleted; `loadBars` reads archived days back transparently,
so finished windows stay reproducible (and re-checkable against LBank) without duplicating a series
per overlapping event. Measured on production candles (2026-11-25): 129 bytes per raw candle row,
11.3 bytes per archived candle (≈ 16 KB per pair-day) — at ~230 active pairs ≈ 3.7 MB a day archived
instead of ≈ 43 MB a day raw; trade evidence ≈ 272 bytes per trade, about 4 checked minutes per
observation. `0` keeps every raw candle. One-minute candles cannot establish the order of trades
inside a minute (a future stop / target study needs the trades themselves; not implemented).

## 8. Surfaces

| Surface   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard | **LBank Spot price observation** (`/lbank-spot`): filters (search, status, Spot / Futures class, coverage, flags, CMC crawl date from / to, stars) and the sortable table (coin, stars, points, CMC crawl, window start and its proof, pair, reference price + delay + _delayed_, highest and lowest (% · price · trade time), status with reasons, coverage with gaps and data freshness, Spot / Futures evidence, flags, _N overlapping_, _Details_: every piece of evidence, gaps, flags with context, results and rules history, rules-v1 audit values). Sorting and filtering use the displayed v2 values. The summary (cutover, Final-only statistics with event and coin denominators, flagged counts, data freshness, the last update and whether it fetched data), CSV export and _Update now_ are on the **Data** page, which also shows the dashboard's and the API's build commit; the rules behind the page's **?** button. |
| API       | `GET /api/observations` (filters `status`, `eligibility`, `stars`, `coverage`, `flags`, `from`, `to`, `search`, `sort`, `dir`, `limit`, `offset`), `GET /api/observations/summary`, `GET /api/observations/:id` (all evidence, result versions, rules changes, v1 audit, the displayed rules version), `GET /api/observations/:id/overlaps`, `GET /api/observations/runs`, `GET /api/observations/routing-check` (`health:read`), `GET /api/observations/export.csv` (`exports:read`; `rules_version` per row), `POST /api/observations/update` (`scan:operate`); legacy: `GET /api/forward/legacy`, `GET /api/forward/legacy/closures.csv`; `/healthz` names the build |
| CLI       | `observation:cutover [--at ISO] [--note]`, `observation:status`, `observation:update`, `observation:probe`, `observation:list`, `observation:check`, `forward:legacy`                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Statistics**: FINAL observations of the current rules only; median, mean and 25th–75th percentile
of the highest and lowest return, overall, per star count and per Spot / Futures class; denominators
in events and distinct coins. One coin's overlapping events are correlated (one price path): the
summary reports how many coins have several events and how many windows overlap; no coin-level
weighting is applied (none is defined). Legacy forward-test returns are never mixed in.

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

## 10. Runbook

The cutover was set on 2026-11-24 to **2026-11-25T00:00:00Z** (passed; immutable). Deploying a rules
change (docs/deployment.md):

```bash
ssh jahantalab && cd /root/jahan/market-predict
alias dc='docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod'
dc exec -T postgres pg_dump -U coins -Fc coins > ~/coins-pre-<migration>-$(date +%F).dump   # backup
git pull && GIT_COMMIT=$(git rev-parse HEAD) BUILD_TIME=$(date -u +%FT%TZ) dc up -d --build
dc exec api node dist/cli.js db:status          # the new migration applied
curl -fsS http://127.0.0.1:38417/healthz        # build.commit = the pulled commit
dc exec api node dist/cli.js observation:update # or wait for the 15-minute job
dc exec api node dist/cli.js observation:status # rules version, statuses, freshness
dc exec api node dist/cli.js observation:check  # routing ok
```

**After a rules change**: every row of the old rules has one `lbank_obs_rules_change` row and the
new `rules_version`; starts are established (`observationsWithoutStart` 0 on `observation:check`);
references verified within a few runs (the first runs fill the backlog; values are provisional and
marked meanwhile); `observation:status` shows the data freshness.

**Duplicate prevention**: one key per table (unique), one observation per event (unique foreign
key), the UTC-midnight cutover (no key in both tables), and the two intake guards. **No missed
event**: the totality of `workflowFor`, the per-batch ledger and intake check, and `reconcile`.

**Rollback**: redeploy the previous image only before a migration is applied; M015 and M016 only
add tables, columns, values and triggers. After the cutover, do not move or delete it (the database
refuses). To pause the tracker set `LBANK_OBSERVATION_ENABLED=false` (events are still recorded; the
job catches up later — candles and trades are historical). Never `db:revert` on real data.

## 11. Limitations

| Id  | Limitation                                      | Effect                                                                                                                                                            |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | No historical LBank Futures status              | Futures YES / NO is snapshot evidence before and after the signal, not proof at the instant; otherwise UNKNOWN                                                    |
| L2  | A delisted pair loses its LBank history (10008) | its open observations end DATA_UNAVAILABLE / PARTIAL after the retries; candles, archives and trades stored before stay                                          |
| L3  | Empirical API properties                        | a candle bounding its trades, trade-list completeness (≥ candle volume) and ≥ 365 days of trade history were measured, not guaranteed; every verified minute re-checks them and reports violations |
| L4  | Same-millisecond order                          | LBank's response order (stable) picks the reference among same-ms trades (flagged when prices differ); highest and lowest in one ms: order unknown                |
| L5  | Evidence lists fetched by the job               | if the job is down more than 2 h after a signal, its list evidence is missing (Spot falls back to candles; Futures stays UNKNOWN)                                 |
| L6  | Starts before rules v2                          | events of 2026-11-25 got `SCAN_COMMIT` from their stored pipeline records; an event without such records would get the job's first sighting (labelled)           |
| L7  | One-minute candles                              | cannot order trades inside a minute; only checked minutes have trades stored                                                                                      |

## 12. Rules history

| Version            | From               | Window                                 | Reference                                                   | Extremes                         |
| ------------------ | ------------------ | -------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| `lbank-spot-obs-1` | 2026-11-24         | crawl time t0 … t0 + 168 h (bars only) | OPEN of the first bar at or after t0 (≤ 2 min, not stale)    | candle High / Low of traded bars |
| `lbank-spot-obs-2` | 2026-11-25 (M016)  | proven start … start + 168 h, exact    | first verified trade at or after the start                  | verified trades                  |

Every v1 row moved to v2 with an `lbank_obs_rules_change` row holding the values it showed; its v1
columns stay unchanged as an audit record; a v1 result row (none existed) would stay and the v2 result
would be the next version. The UI and the CSV show the v2 values and the rules version of each row.

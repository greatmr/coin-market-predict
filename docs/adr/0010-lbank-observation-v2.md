# ADR-0010 — LBank Spot observation rules v2: proven start, first-trade reference, verified extremes

**Status:** Accepted, 2026-11-25 (operator request: correct the LBank Spot Price Observation; the
operator chose the delayed marker, the spike flag and the volume check below). Amends
[ADR-0009](0009-lbank-spot-observation.md); rules `lbank-spot-obs-2`, migration M016.

## Context

The decision report of 2026-11-25 (production read-only, live LBank probes) and this change's own
checks found that rules `lbank-spot-obs-1` measured something other than what the page claims:

| Finding (code at 2551adb)                                                                                                                                                                       | Evidence                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The window started at the crawl start (`t0 = batch.crawledAt`, intake), but the star row is usable only once the scan publishes the Review Queue                                               | 13 batches: scan commit 3.1 s – 8 min 32 s after t0 (00:07 runs refresh daily rows first); the event row 5.4 s – 10 min 47 s                                                            |
| The entry was the next candle's OPEN (`selectEntry`), which LBank sets to the previous CLOSE: never a trade in that minute, ~60 s after t0, and a pre-signal price when nothing traded      | 34 645/34 645 bars; first real trade a median 1.2 s after t0; TIT and LISTA entries were pre-t0 trades                                                                                   |
| Extremes were candle High / Low (`computeExtremes`), which can be that carried OPEN without a trade at that price                                                                            | 30 Highs and 24 Lows of 180 traded minutes on all 60 production pairs; TIT "max rise 0.00 %" from a price never traded after the signal                                               |
| The first and last partial minutes were never observed; `ENTRY_TOO_LATE` ended an observation at once; 2-min / 60-min thresholds were never approved; a 25 % CMC deviation ended it as ambiguous | `observation-rules.ts:121-124, 486, 493`, constants `MAX_ENTRY_DELAY_MS`, `MAX_ENTRY_STALENESS_MS`                                                                                       |
| A complete window without trades ended PARTIAL; `last_update_at` was only a recompute time; a "succeeded" run proved nothing about coverage; raw candles were deleted 7 days after a window | `observationStatus`, `ObservationUpdateService.save`, `CandleStoreService.prune`                                                                                                        |
| `trades.do` returns trades strictly **after** `time` (not at or after, as the report assumed); pages of at most 600                                                                          | live 2026-11-25: `time = T − 1` includes a trade at T, `time = T` does not (eth/0g/re); 601 and 1000 → 10003; a future `time` → 10003                                                    |

## Decision

1. **Observation start = the earliest proven usable time** (`observation-timing.ts`): the pipeline's
   scan-stage finish, recorded right after the transaction that publishes the Review Queue (served
   by `/api/scan` from that commit), label `SCAN_COMMIT`. Without that record: the event's own
   commit (`EVENT_COMMIT`), then the first job run that saw it (`JOB_FIRST_SEEN`), both labelled
   uncertain. Never the crawl time (a database check). The crawl time and the CMC quote time stay as
   provenance; the event key, its UTC date, the cutover routing and the immutable snapshot keep
   using the crawl time, unchanged. The window is exactly `[start, start + 168 h)`.
2. **Reference = the first verified LBank Spot trade at or after the start** (and before the end):
   minutes are walked from the start minute; a zero-volume candle is a verified quiet minute; a
   traded minute's complete trade list is read (`time = m − 1`, next page from `last.time − 1`,
   de-duplicated by id) and checked against its candle. A missing candle or an unverified minute
   stops the search: never skipped. Stored: trade id, millisecond time, price, quantity, delay.
   Labelled "Reference price", an observed trade, not an execution. No delay or staleness threshold:
   the delay is recorded; **delayed** = at least one whole minute after the start verified without
   a trade (operator). A window verified to the end without any trade is **NO_TRADES**.
3. **Minute verification** (operator): complete paging and trade quantity **≥** candle volume
   (the surplus is recorded as the candle's undercount: 13 of 180 production minutes had one more
   trade than their candle, none had fewer); fewer trades than the candle, a page that cannot pass
   one millisecond (> 600 trades) or the page cap, a failed or rate-limited request and a delisted
   pair are distinct unverified outcomes, retried.
4. **Extremes = verified trades**: candles only locate candidates (by High for the highest, by Low
   for the lowest; a candle bounds its minute's trades: 0 of 542 checked minutes had a trade outside
   it), each candidate's complete trades are checked until no remaining candle could hold a higher
   (or an equal and earlier) price, passing over carried-OPEN artefacts. The reference minute and the
   last partial minute come from trades only. Ties: the earliest trade. Order from trade times;
   two trades in one millisecond: unknown (`SAME_MS`). Lowest up to the highest from trades too.
   Highest return ≥ 0 and lowest return ≤ 0 (a database check).
5. **Statuses and retries**: ACTIVE; FINAL (window over, reference and every deciding minute
   verified, every minute with a candle, Spot YES); NO_TRADES; PARTIAL (reference verified, gaps
   after the retries); UNVERIFIABLE (no provable reference); DATA_UNAVAILABLE, MAPPING_AMBIGUOUS,
   ELIGIBILITY_UNKNOWN as before. Gap states: no candle returned, request failed, not fetched,
   pair unsupported, trades unverified. **One retry policy** for every gap, the first minutes
   included: until `end + 24 h` (the existing `FINALIZE_RETRY_MS`).
6. **Review flags, never exclusions**: delayed reference; same-millisecond tie at the reference;
   an extreme set in a minute with exactly one trade (operator: "thin high / thin low", with the
   trade's quantity and USDT value, the minute volume and the trades just before and after); the
   25 % CMC deviation (no longer terminal: a review signal); a mapping snapshot older than
   `LBANK_PAIRS_REFRESH_DAYS` at the signal.
7. **Futures is listing evidence**: the rule is unchanged, the wording says "listed in the snapshots
   before and after the signal", with their times; it never blocks a Spot result and no number is a
   Futures price.
8. **Data model**: v2 columns on `lbank_observation` and its results; the v1 columns stay as an
   audit record that never changes once a row leaves v1; every rules change writes
   `lbank_obs_rules_change` first (trigger), and a finalized row reopens only through that log
   (its result rows stay, append-only). Trades of checked minutes (`lbank_spot_trade`) and the checks
   (`lbank_spot_trade_minute`) are shared per pair, immutable once verified.
9. **Retention**: raw candles past `LBANK_CANDLE_RETENTION_DAYS` that no unfinished observation
   needs are archived per pair and UTC day (gzip of the exact CSV + SHA-256) before deletion, whole
   days only; archives and trades are kept. Measured on production candles: 11.3 bytes per candle
   archived vs 129 raw (≈ 16 KB per pair-day).
10. **Freshness and build**: per observation `data_through`, last successful fetch, last attempt and
    error, `retry_until`, separate from the recompute time; the run report says whether it fetched
    new data or only recomputed; `/healthz` and the Data page show the deployed commit.

## Consequences

- \+ Every displayed price is a trade with an id and a millisecond time; FINAL proves the whole
  `[start, end)` including both partial minutes; a quiet market, a gap and an outage are different
  outcomes.
- \+ The 85 open v1 observations (none terminal on 2026-11-25) are recalculated with an audit row
  each before the first window would have ended.
- − More requests: each observation reads its reference minute, its last minute and a few candidate
  minutes (about 4 per observation on production data, shared per pair); the first runs after the
  upgrade fill the backlog over several 15-minute runs (provisional values meanwhile).
- − The candidate bound (a candle's High / Low bounds its trades) and the trade list's completeness
  are empirical properties of LBank's API, re-checked on every verified minute and reported if
  violated, not documented guarantees. Same-millisecond order is LBank's response order (stable
  across requests), flagged where it matters.
- − One-minute candles cannot order trades inside a minute; any future stop / target study needs the
  trades themselves (not implemented).

## Alternatives rejected

- **Keep the candle OPEN with approved 2-min / 60-min thresholds** (report B2): ~60 s unobserved on
  every event and carried-OPEN artefacts remain.
- **Close of the first traded minute** (B3): misses the first minute or two.
- **Read every trade of every window**: tens of thousands of requests per liquid window; the candles
  already bound where an extreme can be.
- **Strict volume equality** (operator declined): ~7 % of deciding minutes would block FINAL although
  the trade list is the longer side.
- **Numeric spike thresholds** (revert X % in Y min, notional below Z): no defensible values; the
  operator chose the single-trade rule.
- **Crawl time or the CMC quote time as the start**: before the signal could be used. **The event's
  own commit as the start**: later than the proven publication.

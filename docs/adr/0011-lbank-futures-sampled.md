# ADR-0011: LBank Futures sampled observation, reference latency, observation views

Status: accepted, 2026-11-27 (operator request: separate Spot and Futures results; a crowded panel;
references shown minutes late; slow 00:07 UTC publications).

## Context and measurements (production, 2026-11-27)

1. **Futures data.** LBank's official contract API (`lbkperp.lbank.com/cfd/openApi/v1/pub`) serves
   contracts, the current order book and one current `marketData` snapshot; it has no trade or
   candle history (kline / trade paths → 403). The website's candles come from a client-signed
   gateway (unsigned → 10006); reproducing its signature would be evasive access, so it is not used.
   In `marketData`, `lastTime` is the refresh time of the snapshot (it moved on all 844 contracts in
   30 s, also on 107 with unchanged volume and turnover), not a trade time. CMC's LBank Futures list
   pins contracts to CMC ids by market URL (BIGTIME 28230 → BIGTIMEUSDT, BABY 32198 → BABYUSDT) but
   mis-attributes some tickers (DYDXUSDT → ethDYDX 11156, MONUSDT → MoneyByte 5066).
2. **Reference latency (SOLV, 2026-11-25).** Start 16:07:06.894 (scan commit), first trade
   16:07:07.554 (+0.660 s), observation committed 16:07:15.598, start minute checkable from 16:08:05;
   the first check came with the `*/15` cron at 16:15:00 (run 152.8 s, finished 16:17:32.853). The
   page reloaded only when the hourly CMC batch changed (or by hand), so Verified could appear up to
   ≈ 1 h after it was stored. Trade checks were stamped with the run's start, not the read time.
3. **00:07 UTC publications.** Every 00:07 run since 2026-11-20 spends 506–553 s in the `daily` stage
   (all other hours 0.2–2.4 s): at a new UTC day every screen candidate's newly completed daily row is
   fetched from CMC, one request each (260 on 2026-11-26) at `CMC_WEB_REQUESTS_PER_MINUTE` (≈ 2 s per
   request → ≈ 520 s), before the scan can run. Crawl → scan commit (the window start):
   2026-11-25 00:07:00.053 → 00:15:32.510 (+8 min 32.457 s); 2026-11-26 00:07:00.055 → 00:15:44.074
   (+8 min 44.019 s); 2026-11-27 00:07:00.072 → 00:15:39.358 (+8 min 39.286 s). No retry, contention or timeout
   was involved (attempts 1, `failed 0`, `stoppedBy null`). Reference delays of those groups do not
   differ from other hours: paired by coin (56 coins with events in both), 27 slower and 29 faster,
   median difference −0.023 s; the longer midnight tail comes from thin coins that reopen events at
   every new UTC day (e.g. TIT). From the last LBank trade before the crawl to the (later) reference
   the price moved by a median −0.35 %, +0.47 %, −0.03 % on the three dates (mixed sign; context only).

## Decision

- **Futures** gets its own observation (`lbank_futures_observation`, rules `lbank-futures-sampled-1`,
  migration M017; docs/lbank-spot-observation.md § 13): minute `marketData` snapshots; a trade is
  proven only between two snapshots whose 24 h turnover rose; the reference is the first such trade
  wholly inside the window, the extremes are bounds, statuses never FINAL. Events whose start was not
  sampled (all before this deploy) are `HISTORY_UNAVAILABLE` with the exact reason. Spot is unchanged
  (no Spot row or rule is touched; `lbank-spot-obs-2` stays).
- **Latency**: follow-up runs when a new start minute closes and each minute while a young reference
  is pending; the page reloads on a change token (`/api/observations/version`, every 30 s); trade
  checks record the real read time; the detail shows market, processing and display delays apart.
- **00:07 UTC**: no code change. The stage is doing required work under the operator's CMC request
  pace, not failing. Faster publication would need a higher burst rate toward the CMC website or a
  pre-fetch shortly after 00:00 UTC (whether the completed daily row is final then is unverified):
  an operator decision (intend.md unresolved decision 2). The detail explains the stage durations.
- **Views**: one venue at a time (Spot / Futures / Compare), two-line cells, freshness bar,
  plain-language flags, foldable detail sections, an overlap timeline.

## Consequences

- Spot vs Futures comparisons exist only for events detected after 2026-11-27's deploy, with weaker
  Futures evidence (time ranges, bounds), labelled as such everywhere.
- ≈ 43 000 extra LBank requests a month; ≈ 1 440 snapshot rows per needed contract per day (kept as
  evidence).
- A process restart loses the in-memory snapshots that anchor a contract mapped just after its start;
  that event's Futures result is then `HISTORY_UNAVAILABLE` (stated, never filled).

## Addendum 2026-11-27 (later): observed quote replaces the turnover-bracket reference

Investigation (CFG, PONS, THETA, 09:07 UTC batch): the 2–8 minute "trade between" intervals came
from our sampling — (1) the sampler skipped storing fetched snapshots when an older snapshot of the
contract existed (first stored post-start snapshot ≈ +1 min 52 s), and (2) the rising-24 h-turnover
rule ignored minutes in which the price moved (trades) while rolling turnover fell (CFG 2, THETA 4
such minutes). Inventory before the change (production, 10:27 UTC): 280 Futures rows, all
`lbank-futures-sampled-1` — 232 not sampled at start, 39 no contract, 3 ambiguous, 6 open with a
reference: 2 with the first eligible response retained (CFG and REZ, 10:07), 4 missing it because of
the storage defect (CFG, PONS, THETA 09:07; SOMI 10:07); the turnover rule demonstrably delayed 2
(CFG and THETA, 09:07).

Decision (operator): rules `lbank-futures-quote-1` (M018; docs § 13a) — the first valid `lastPrice`
observed from a request sent at or after the publication, timed by its response; requested at
publication; turnover is context only; storage defect fixed. Older rows keep their method and label;
their post-fix quote is kept apart; nothing historical is rewritten or invented.

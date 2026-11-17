# ADR-0007 — Exchange listings and the coin's Average Return on the forward-test tab

**Status:** Accepted, 2026-11-17 (operator request: per-coin Average Return, Spot / Futures
availability, Bithumb).

## Context
The operator asked for three additions to the forward-test tab: a simple per-coin summary of the
Returns of all stored events, whether each coin is available in Spot, Futures or both (checked in
the actual market listing, not inferred from a Spot listing), and whether it is listed on Bithumb,
each with a filter. Requirements: missing Returns are never counted as 0 %, a summary built on
provisional or lower-bound Returns must say so and is never presented as a trading result, an
unverified listing reads "Unknown", never "No", and neither the LBank eligibility condition nor the
scanner's scoring may change as a side effect.

Before this, the only exchange data were the LBank Spot markets list (a Tier 1 input, decisions
D1, D2) and the CMC Markets rows of review candidates. The live chart *inferred* an LBank
perpetual (`LBANK:<BASE>USDT.P`) from the Spot pair.

## Decision
- **Average Return (coin).** `coinAverageReturns` (pure, `forward-test/cohort.ts`, exact decimals)
  groups every stored event by CMC id — any status and star count, not only the rows a view, filter,
  page or the overlapping-events dialog shows — and gives the event count, how many have a numeric
  Return (the latest outcome's `peak_return_pct`, exactly what the Return column shows), how many of
  those are lower bounds (`peak_kind` ≠ EXACT, shown with ≥), and their arithmetic mean. An event
  without a Return is left out. Any lower bound makes the mean a lower bound too (every true Return
  is ≥ its shown value), so the dashboard shows it as `≥ x %` with "lower bound · n not final". The
  label is "Average Return": a peak return, not profit. No sum and no star breakdown. It is a read
  model: no outcome changes, so `FORWARD_RULES_VERSION` is unchanged.
- **"Spot / Futures" means LBank**, the strategy's venue (operator interpretation recorded here):
  LBank Spot from the existing LBank Spot list, LBank Futures from LBank's own Futures markets list.
- **Source: the existing CMC website exchange route**, `v3/exchange/market-pairs/latest`, already
  used for LBank Spot: `slug=lbank&category=perpetual` + `category=futures` (verified 2026-11-17:
  737 USDT perpetuals; no dated futures) and `slug=bithumb&category=spot` (497 KRW / BTC pairs).
  Every pair carries CMC's own base-asset id, so listings are matched by CMC id, never by ticker; no
  new API client, no new provider. Stored in `venue_crawl` as kinds `lbank_futures_pairs` and
  `bithumb_spot_pairs` (migration M012), with the normalized pairs, hashes and every failed attempt.
- **Yes / No / Unknown** (pure, `venues/exchange-lists.ts`): YES when a pair in a verified list
  carries the coin's CMC id; NO only when a verified list has none and no pair without a CMC id
  carries the coin's ticker; otherwise UNKNOWN with a reason (`LIST_NOT_FETCHED`, `LIST_FAILED`,
  `LIST_INCOMPLETE`, `LIST_STALE`, `LIST_UNSUPPORTED`, `UNMAPPED_PAIR_SAME_TICKER`). Verified = the
  latest COMPLETE list, no older than `LBANK_PAIRS_MAX_AGE_DAYS` (LBank Spot, the scanner's own
  rule) or `EXCHANGE_LISTS_MAX_AGE_HOURS` (72; LBank Futures, Bithumb). A later failed attempt
  keeps a verified list in use. The answers are the coin's listing *now*, not at identification.
- **Fetching.** The `venues` stage, after the scan, fetches the two new lists when the stored one
  is `EXCHANGE_LISTS_REFRESH_HOURS` (24) old; a failed or incomplete attempt is retried after at
  most 6 h, not every hour; it stops at the request reserve or when the source is unavailable and
  never fails the run. `exchange-lists:refresh` fetches them now under the pipeline lease. About 4
  requests per refresh. The LBank Spot list keeps its own stage and 30-day cadence (D2).
- **Not Tier 1 inputs.** The scanner never reads the two new lists; eligibility, LBank status,
  stars, points and the queue are unchanged (`RULESET_VERSION`, `RANKING_RULESET_VERSION`
  unchanged). A database test removes both lists, rescans and compares every result.
- **Surfaces.** `GET /api/forward/events` rows carry `coinAverageReturn` and `exchanges`
  (`lbankSpot`, `lbankFutures`, `bithumb`); filters `market=both|spot_only|futures_only|spot|futures|
  neither|unknown` and `bithumb=listed|not_listed|unknown` run in SQL with the same rule
  (`matchesMarket` / `matchesBithumb`, checked against PostgreSQL in the e2e suite);
  `GET /api/forward/events/:id/overlaps` adds the coin summary; `GET /api/forward` adds
  `exchangeLists`. MCP `get_forward_events` returns the new fields; the coin agent's inputs are
  unchanged (its tool maps fields explicitly).

## Consequences
- \+ Futures availability is a fact from LBank's Futures list, with its fetch time, instead of an
  inference; an unverified list can never make a coin look unavailable.
- \+ No new source contract: the same polite client, budget, circuit breaker and stored evidence.
- − Listings lag the exchange by up to a day (LBank Spot: up to its 30-day cadence) and depend on
  CMC's mapping of each pair to a CMC id; a pair CMC cannot map leaves a same-ticker coin Unknown.
- − The live chart still offers its labelled LBank perpetual fallback; it could use this list instead.
- − The average of one coin's events mixes correlated observations of one price path; it describes,
  it does not estimate an edge.

## Alternatives rejected
- **Inferring Futures from Spot** (the chart's `.P` fallback): explicitly ruled out by the request.
- **LBank's and Bithumb's own public APIs**: new API clients and a source assessment, and both
  identify coins by ticker only, which the identity rules forbid (data-semantics: never match by
  symbol).
- **Per-coin market routes** (`cryptocurrency/market-pairs` with `category=perpetual` per coin): one
  request per coin instead of four per day, and the top-100 cap would leave "No" unprovable.
- **Making Bithumb or LBank Futures part of Tier 1**: not requested; it would change eligibility
  and the ruleset version.

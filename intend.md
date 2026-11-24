# Coins Predicts — intent

## Purpose

Implement the **Two-Tier VMC strategy** (LBank Spot developer handoff, 05 Nov 2026;
specification: `docs/strategy-two-tier-vmc.md`). Every hour, Tier 1 screens CoinMarketCap assets
for unusual trading activity — current rolling-24h volume ÷ circulating market cap (VMC) against
each asset's own 3-, 7- and 30-day means of completed daily VMC — and hands a documented Review
Queue to Tier 2, a human TradingView chart review with an optional, manually completed LBank Spot
trade plan. Results go to a dashboard, exports, an MCP server and a Telegram channel. Outputs are
review material, not predictions or trading signals.

Add-on (operator handoff, 10 Nov 2026; `docs/forward-test.md`): the **Star Event Forward Test**
records the first priced 1/2/3-star detection per coin, UTC day and star count and measures the
highest later High until the end of the UTC day containing detection + 168 h, compared by star
group. A descriptive measurement, not a trade, a signal or a profit claim.

(Superseded on 2026-11-05: the momentum "surge screen", Claude agent reviews, paper trading,
backtests and the six-month VMC baseline. See `docs/strategy-two-tier-vmc.md` § 10.)

Added 2026-11-12 (`docs/adr/0005-coin-agent.md`): a live TradingView chart in the coin details,
and an owner-only Claude agent that, on request, reads one coin's stored data and gives its own
view on a pump within 7 days. That view is kept as history and treated as review material, like
everything else here.

Changed 2026-11-24 (`docs/adr/0008-storage-scope.md`, D4): the Eligible, Needs review and Excluded
pages and exports are gone. Every coin is still screened each hour and kept in the coin registry,
but only what the strategy found (the Review Queue) is stored per coin; everything else is counted
per run and traced on request. Missing or ambiguous data fails closed.

Added 2026-11-17 (`docs/adr/0007-exchange-listings.md`): on the forward-test tab, each coin's
Average Return over all its stored events (a peak return, never profit; a lower bound while any
Return is), and whether the coin is listed now on LBank Spot, LBank Futures and Bithumb, each from
that exchange's own markets list on CMC by CMC id (Unknown when the list is not verified), with
filters. Descriptive attributes: no Tier 1 rule, star or point reads them.

## Requirements

1. **Sources**: no paid market-data subscriptions. Use the existing, explicitly selected CMC
   website collector (no new API client, PDF p.2); no CAPTCHA bypass or evasive proxies. Free
   official APIs only as an explicit, opt-in alternative.
2. **Universe**: every coin the selected source lists, every hour; canonical identity by CMC id
   and chain + contract (never symbol alone); honest coverage reporting.
3. **Tier 1 rules** (p.3–19): rank 101–1200, circulating cap ≥ $15M, listed ≥ 60 days, not a
   stablecoin or tokenized asset, a verified LBank Spot pair; daily VMC means over exactly the
   last 3 / 7 / 14 / 30 completed UTC days; YES iff current ≥ 1.5 × mean (14d context only);
   stars = YES count; queue ranked by stars, then weighted points (3d 60 · 7d 25 · 30d 15;
   Weighted Star Ranking Addendum, D3, `weighted_star_v1`). Exact decimal arithmetic; missing or ambiguous inputs
   give N/A or NEEDS_REVIEW with a reason, never a guess.
4. **Semantics**: UTC storage; USD values; circulating market cap (never FDV); rolling-24h volume
   kept separate from daily volume; provider update, crawl and scan times kept apart; nulls carry
   reasons; daily revisions preserved.
5. **Pipeline**: hourly, non-overlapping across instances, bounded retries, idempotent writes,
   restart recovery, no backfill of missed hours, Telegram retries independent of collection.
6. **Outputs**: Review Queue and Run Metadata as CSV (All Eligible, Needs Review and Excluded
   removed on 2026-11-24, D4: those coins are counted in Run Metadata, not listed)
   with checksums (p.17); queue withheld when the batch is incomplete or the LBank feed is
   unavailable (p.18); dashboard with per-coin calculation traces; read-only MCP; Telegram
   compact summary with dry-run mode.
7. **Human review** (p.15, p.24–27): venue decision, event day, LBank verification, chart review
   fields, final decision, manual trade plan validation; append-only revisions.
8. **Coin details extras** (2026-11-12): a live TradingView 1D chart (a proxy for the LBank Spot
   pair, which TradingView does not carry) that fills the Tier 2 chart fields on request; and the
   Claude coin agent for owners only, at most 5 runs per rolling 12 hours, authenticated with the
   operator's subscription OAuth token, with every run and its inputs stored.
9. **Forward test** (add-on): automatic events from the published Review Queue (no approval),
   unique per (CMC id, UTC date, stars), immutable reference price, daily Highs of the same
   coin's CMC USD series only, never a pre-signal High or Close, FINAL only after the final day's
   High; versioned outcomes and a star-group report on FINAL events.

## Assumptions

- Single operator, personal research use; one deployment.
- Hourly cadence is acceptable; minute-scale moves are out of reach.
- Implementation assumptions A1–A20 are listed with reasons in `docs/strategy-two-tier-vmc.md` § 9.
- Display timezone Asia/Tehran (configurable).

## Constraints

- The CMC website collector uses website JSON endpoints with no supported API contract. It is
  explicitly selected by the operator and may break if CMC changes access.
- CMC's LBank markets data has no trading status. Operator decision (2026-11-05): a pair in the
  Markets section of CMC's LBank page counts as tradable; the list is fetched once and refreshed
  every 30 days or on demand (strategy document, D1, D2).
- Free official API tiers supply listings only (no daily history or LBank pairs).

## Non-goals

- Real order placement, brokerage integration, position sizing or portfolio management.
- Automatic buy/sell signals, predicted returns, profit claims or calibrated probabilities. The
  coin agent's outlook is an on-request qualitative opinion with a confidence level, not a
  probability, price target or signal.
- Intrahour monitoring, order-book trading, or minute-level signals.
- Multi-tenant SaaS.

## Acceptance criteria

- `npm test` and `npm run test:db` pass offline, including the PDF's acceptance cases (p.19:
  A exact 1.5 boundary, B ranks / cap / age boundaries, C mean of ratios, D missing day,
  E zero / stale / unverified inputs; F queue order, superseded by the weighted star ranking's own
  acceptance cases); fixture mode runs end to end (fixture crawl
  → PostgreSQL → Tier 1 scan → exports → dashboard / MCP → Telegram dry run).
- Fixture data is labelled synthetic everywhere it appears (DB flag, dashboard, exports, Telegram).
- A batch is never COMPLETE unless every listed coin was read and ranks 1–1200 are contiguous
  (ranks 1–1200 are stored as snapshots; the rest is counted, D4).
- Only the Review Queue is stored per coin: a 0-star eligible coin is screened every hour and is
  stored from the hour it reaches a star; missing or ambiguous data never becomes a signal.
- Every displayed or exported number traces to stored inputs (trace view, inputs hash, revision ids).
- Telegram live delivery only with `TELEGRAM_MODE=live` and valid credentials.

## Unresolved decisions (owner: operator)

1. **Live data source.** Implemented choices: fixture, the CMC website collector
   (`DATA_SOURCE=coinmarketcap_web`, no key — the only live source with daily rows and LBank
   pairs), or official keyed APIs (listings only). Website routes verified 2026-11-03 / 2026-11-05.
2. **Request budget.** `CMC_WEB_MONTHLY_REQUEST_BUDGET=30000` covers the hourly listing, LBank
   pairs and about one daily-history request per screen candidate per UTC day; confirm this is an
   acceptable load for the website.
3. **Redistribution in Telegram.** Summary rows are lower-risk than bulk data tables (the full
   Excel workbook attachment was removed on 2026-11-24 with the XLSX export). Confirm the
   provider's terms for the recipients (private members vs a public channel).
4. **LBank list cadence.** Decided: listed pairs count as tradable, list refreshed every 30 days
   or manually (D1, D2). Revisit if suspended LBank pairs keep reaching the queue
   (`LBANK_REQUIRE_MANUAL_VERIFICATION=true` restores a human check per pair).
5. **Storage retention.** Decided 2026-11-24 (D4, `docs/adr/0008-storage-scope.md`): store per
   coin only the Review Queue, and snapshots of ranks 1–1200 for `RETENTION_DETAIL_DAYS` (default
   7); afterwards only queue inputs, forward-test snapshots and BTC/ETH stay. Earlier rows are
   removed once with `storage:prune` after a backup. Set `0` to keep all hourly detail.
6. **Intraday High for the signal day.** Decided 2026-11-18 (rules `star-forward-2`): the signal
   day after detection is measured with the same CMC history route's hourly OHLC (`interval=1h`,
   assessed in `docs/source-feasibility.md`; used only when its hours match the daily High). Still
   open: the minutes between detection and the end of its hour when that hour's High came first —
   no sub-hourly source with true Highs is verified (`15m` is coarser, `5m` not served), so such
   events stay `INCOMPLETE_DAY0` (lower bound) unless a later High settles them.

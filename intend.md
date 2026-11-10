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
6. **Outputs**: All Eligible, Review Queue, Needs Review, Excluded and Run Metadata as CSV + XLSX
   with checksums (p.17); queue withheld when the batch is incomplete or the LBank feed is
   unavailable (p.18); dashboard with per-coin calculation traces; read-only MCP; Telegram
   compact summary with dry-run mode.
7. **Human review** (p.15, p.24–27): venue decision, event day, LBank verification, chart review
   fields, final decision, manual trade plan validation; append-only revisions.
8. **Forward test** (add-on): automatic events from the published Review Queue (no approval),
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
- Automatic buy/sell signals, predicted returns, profit claims or calibrated probabilities.
- Intrahour monitoring, order-book trading, or minute-level signals.
- Multi-tenant SaaS.

## Acceptance criteria
- `npm test` and `npm run test:db` pass offline, including the PDF's acceptance cases (p.19:
  A exact 1.5 boundary, B ranks / cap / age boundaries, C mean of ratios, D missing day,
  E zero / stale / unverified inputs; F queue order, superseded by the weighted star ranking's own
  acceptance cases); fixture mode runs end to end (fixture crawl
  → PostgreSQL → Tier 1 scan → exports → dashboard / MCP → Telegram dry run).
- Fixture data is labelled synthetic everywhere it appears (DB flag, dashboard, exports, Telegram).
- A batch is never COMPLETE unless every listed coin was stored and ranks 1–1200 are contiguous.
- Every displayed or exported number traces to stored inputs (trace view, inputs hash, revision ids).
- Telegram live delivery only with `TELEGRAM_MODE=live` and valid credentials.

## Unresolved decisions (owner: operator)
1. **Live data source.** Implemented choices: fixture, the CMC website collector
   (`DATA_SOURCE=coinmarketcap_web`, no key — the only live source with daily rows and LBank
   pairs), or official keyed APIs (listings only). Website routes verified 2026-11-03 / 2026-11-05.
2. **Request budget.** `CMC_WEB_MONTHLY_REQUEST_BUDGET=30000` covers the hourly listing, LBank
   pairs and about one daily-history request per screen candidate per UTC day; confirm this is an
   acceptable load for the website.
3. **Redistribution in Telegram.** Summary rows are lower-risk than bulk data tables, and each
   report now also attaches the full workbook (CMC-derived values for every listed coin) at the
   operator's request (2026-11-05; `TELEGRAM_ATTACH_EXPORT`). Confirm the provider's terms for the
   recipients (private members vs a public channel).
4. **LBank list cadence.** Decided: listed pairs count as tradable, list refreshed every 30 days
   or manually (D1, D2). Revisit if suspended LBank pairs keep reaching the queue
   (`LBANK_REQUIRE_MANUAL_VERIFICATION=true` restores a human check per pair).
5. **Storage retention.** Default `RETENTION_DETAIL_DAYS=30`: afterwards, coins outside the Tier 1
   band keep one snapshot per UTC day and scan rows excluded only by rank/cap keep one batch per
   UTC day. Set `0` to keep all hourly detail.
6. **Intraday High for the signal day.** No verified source gives a post-detection intraday High;
   such events stay `INCOMPLETE_DAY0` (lower bound) unless CMC's `timeHigh` or a later High settles
   them. Adding a source needs a source assessment (`docs/forward-test.md` § 14).

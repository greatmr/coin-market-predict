# Tier 1 input mapping and crawl gaps

First Tier 1 deliverable (PDF p.8, p.20, p.21): every input field mapped to its real source in the
existing crawler, with sample values, units, timezone and missingness, plus the list of actual gaps.
Strategy rules: [strategy-two-tier-vmc.md](strategy-two-tier-vmc.md).

## Existing crawler (before this change)

- **Source**: CoinMarketCap website collector (`DATA_SOURCE=coinmarketcap_web`), one shared polite
  HTTP queue (`src/sources/coinmarketcap-web/client.ts`), 30 requests/minute, persisted monthly
  budget, Retry-After and denial suspension.
- **Batch cadence**: one listing request per hourly run (`PIPELINE_CRON` minute 7, UTC); one crawl
  batch per UTC hour slot. Documented interval 60 minutes → `max_quote_age` = 120 minutes (p.12).
- **Storage**: `MarketSnapshot` unique per (provider, CMC id, slot, quote currency) — first write
  wins, so replaying a batch never duplicates rows. Daily history existed only for explicitly
  configured ids and the old watchlist (`VmcDailyObservation`, 62 ids).
- **Live evidence used below**: batch `2026-11-04T15:00Z` (8,038 coins, crawled
  `2026-11-04T15:14:27.218Z`), daily rows retrieved 2026-11-03/04, and two read-only requests to the
  market-pairs routes on 2026-11-05.

## Field mapping

Units: USD unless stated. Times: UTC (`timestamptz`), ISO 8601 with `Z` in exports.

| PDF field | Source page / route → field | Stored as | Sample (real) | Missingness (live batch 2026-11-04 15:00) |
|---|---|---|---|---|
| CMC ID | Listing `/data-api/v3/cryptocurrency/listing` → `id` | `MarketSnapshot.providerAssetId`, `AssetIdentity`, `CmcAsset.cmcId` | `2` (Litecoin) | 0 % — malformed rows are skipped and counted |
| Rank | Listing → `cmcRank` | **gap G1** (dropped by parser) → `MarketSnapshot.rank` | `1` (Bitcoin) | featured rows have none (e.g. id 38442 *CoinMarketCap 20 Index DTF*) |
| Name / symbol / slug | Listing → `name`, `symbol`, `slug` | `Asset`, `CmcAsset` (+ change log) | `Litecoin`, `LTC`, `litecoin` | 0 % |
| Tags | Listing → `tags[]` | **gap G3** (only mapped categories kept) → `MarketSnapshot.tags`, `CmcAsset.tags` | `["mineable","pow",…,"layer-1"]` | not measured before the fix |
| First listing date | Listing → `dateAdded` | **gap G2** → `MarketSnapshot.dateAdded`, `CmcAsset.dateAdded` | `2010-07-13T00:00:00.000Z` (BTC) | not measured before the fix |
| Contract / network evidence | Listing → `platform.slug`, `platform.token_address` | `AssetContract`, `CmcAsset.platform` | `bnb` / `0x2f8A…2867` | absent for native coins |
| Current USD price | Listing → `quotes[name=USD].price` | `MarketSnapshot.price` (numeric 38,18) | `56.78806002653251` (LTC) | 0 of 8,038 |
| Market cap (circulating) | Listing → `quotes[USD].marketCap` | `MarketSnapshot.marketCap` (38,4), provenance `provider_reported` | `4417755004.9915` (LTC) | 3,859 of 8,038 null (CMC reports 0 = unknown supply; FDV never substituted) |
| Rolling 24 h volume | Listing → `quotes[USD].volume24h` | `MarketSnapshot.volumeRolling24h` (38,4) | `200247636.2929` (LTC) | 0 of 8,038 |
| Provider update time | Listing → `quotes[USD].lastUpdated` (fallback row `lastUpdated`) | `MarketSnapshot.observedAt` | `2026-11-04T15:14:18.061Z` (LTC) | 0 null; 1 stale (> 90 min); oldest `2022-09-24` (untracked coin) |
| Crawl time | Collector clock when the listing response was stored | `MarketSnapshot.collectedAt` | `2026-11-04T15:14:27.218Z` | 0 % (one value per batch) |
| Scan time | Tier 1 processing clock | `ScanResult.computedAt` (new) | — | — |
| Same observation for volume and cap | Both from the same `quotes[USD]` object of one listing row | evidence string `listing_quote_usd` | — | `MISMATCHED` cannot occur for this source |
| Daily volume (completed UTC day) | Historical route `/data-api/v3.1/cryptocurrency/historical?interval=1d` → `quotes[].quote.volume` | `DailyMetric.volumeUsd` (38,8, exact source digits) | `18919774.51` (id 23095, 2026-11-03) | **gap G4**: only 62 ids had rows |
| Daily market cap at close | Same row → `quote.marketCap` | `DailyMetric.marketCapUsd` | `255079234.00` | 409 of 9,121 website rows had `marketCap = 0` → invalid date |
| Daily close timestamp | Same row → `quote.timestamp` (= `timeClose`) | `DailyMetric.sourceCloseAt` | `2026-11-03T23:59:59.999Z` | present in every sampled row |
| Daily close price | Same row → `quote.close` | **gap G5** → `DailyMetric.closeUsd` | `1.2544089281` (XRP, 2026-10-30, fixture) | — |
| Daily row completeness | `timeClose` before the crawl time | rows with `timeClose ≥ crawl time` are skipped | — | the open day is never stored |
| LBank Spot pairs | **gap G6** — not crawled. Available from CMC's LBank markets data `/data-api/v3/exchange/market-pairs/latest?slug=lbank&category=spot` → `marketPair`, `category`, `baseCurrencyId`, `baseSymbol`, `quoteSymbol`, `volumeUsd`, `lastUpdated` | `VenueCrawl` (+ `VenuePairEvent`) | `BTC/USDT`, base id `1`, `lastUpdated 2026-11-05T06:06:11Z`; 900 spot pairs | no trading-status field in the feed |
| CMC Markets venue rows | **gap G7** — not crawled. Coin market pairs `/data-api/v3/cryptocurrency/market-pairs/latest?slug=<slug>&category=spot` → `exchangeName`, `marketPair`, `volumeUsd`, `volumePercent`, `lastUpdated` | `VenueCrawl` (asset markets) | LTC: Binance `LTC/USDT` $12.25M (6.28 %); 500 pairs total | per-asset; top 100 pairs stored |
| Crawl batch record | `PipelineRun.coverage` JSON only | **gap G8** → `CrawlBatch` (completeness, field counts, missing ranks, errors) | — | — |

## Gaps and the targeted upstream changes

| Id | Missing field | Affected rule | Example record | Upstream change made |
|---|---|---|---|---|
| G1 | `cmcRank` | Rank 101–1200 (p.9) | listing row id 1 has `cmcRank: 1`; id 38442 has none | Parser and snapshot store `rank`; missing rank → `RANK_MISSING` (NEEDS_REVIEW) |
| G2 | `dateAdded` | Listing age ≥ 60 days (p.9) | id 1 `dateAdded 2010-07-13T00:00:00Z` | Stored per snapshot and on `CmcAsset` |
| G3 | raw `tags` | Stablecoin / tokenized exclusion, fan tokens eligible, retain tags (p.9, p.10) | id 38442 tags `defi, defi-index, …` | Raw tags stored per snapshot and on `CmcAsset` with a change log |
| G4 | Completed daily rows for the universe | 3/7/14/30-day means (p.5, p.11) | rows existed for 62 ids only | The existing history route and its parser now refresh screen candidates once per UTC day (35-day window, bounded, budget-reserved) |
| G5 | Daily close price | Event-day context (p.15) | XRP 2026-10-30 close `1.2544089281` | Stored with each daily row (open/high/low/close) |
| G6 | LBank Spot pairs | LBank eligibility (p.3, p.9, p.10) | `BTC/USDT` base id 1 | New route on the existing CMC website client (the Markets section of CMC's LBank page), fetched once and refreshed every 30 days or on demand (D2). **Remaining gap**: no trading status; by operator decision D1 a listed pair counts as tradable (reviewers can mark it not tradable) |
| G7 | CMC Markets venue rows | Venue concentration review (p.15) | LTC Binance `LTC/USDT` 6.28 % | Coin market-pairs route for review candidates, refreshed at most daily; missing/partial → `venue_review` PENDING |
| G8 | Batch metadata | crawl_batches (p.16), observability (p.18) | — | `CrawlBatch` written by the collect stage |

### After the change: first live batch (2026-11-05T10:00Z, crawled 10:20:17Z)

| Field | Result |
|---|---|
| Listing | 8,027 listed, 8,027 stored; batch COMPLETE; ranks 1–1200 contiguous, no duplicates |
| `rank` | present for all 8,027 (max 8,027); no featured row without a rank in this batch |
| `dateAdded` | present for all 8,027 |
| `tags` | non-empty for 7,914; 113 coins have no tags (classified `regular` unless an override says otherwise) |
| Market cap | 3,850 null (CMC reports 0 for unknown supply); 873 coins ≥ $15M overall. Of the 1,100 coins ranked 101–1200, 428 are below $15M, so rank + cap leave 672 |
| Provider update time | present for all; 1 quote older than 120 min overall, none in ranks 101–1200 (quote age there ≈ 74 s) |
| Daily rows | 35 completed days per candidate (2026-10-01 … 2026-11-04); cap-zero days are stored and marked invalid (counts in the run metrics) |
| LBank pairs | 900 of the 901 pairs CMC reported → crawl INCOMPLETE, every LBank status UNKNOWN, queue withheld (see § LBank pair count below) |

### LBank pair count (found in the first live batch, fixed the same day)
CMC's LBank list had 901 spot markets on 901 market ids but only 900 distinct pair names:
`MARS/USDC` was listed twice, for two different CMC assets (ids 154 and 33335). The crawler keyed
pairs by name, so one market was dropped, the list never reached the reported count, and the feed
was marked INCOMPLETE. The crawler now keys pairs by CMC market id (keeping both `MARS/USDC`
markets, which the resolver then treats as an ambiguous ticker → NEEDS_REVIEW with mapping tasks,
p.10) and overlaps its pages by 50 rows, because the list is ordered by volume and can move
between page requests. Re-run against the live list on 2026-11-05: 901 of 901 pairs in 2
requests, COMPLETE.

First pipeline batch with the fix (`2026-11-05T11:00Z`): batch COMPLETE, LBank feed COMPLETE (901
listing events recorded), 0 eligible / 299 needs review / 7,728 excluded, queue EMPTY. Of the 299,
287 have an LBank pair that is listed but not yet verified tradable (no trading status in the feed,
G6), 12 have an ambiguous ticker and 1 an ambiguous class; 35 already meet at least one window. The
35 open mapping tasks are mostly LBank tickers that differ from the CMC symbol (e.g. `DUSK1`,
`VANA1`, `GME1`) plus the two `MARS/USDC` markets. At that point every listed pair still needed a
reviewer's verification (A7).

After operator decisions D1 (a pair in the LBank Markets list counts as tradable) and D2 (list
fetched once, refreshed every 30 days or on demand), the `2026-11-05T12:00Z` batch recomputed to
287 eligible, 13 needs review (12 ambiguous tickers, 1 ambiguous class) and 7,727 excluded, with
34 coins in the Review Queue (PUBLISHED).

No other site is used to fill a gap, and no value is inferred from the PDF screenshots (p.8).
Synthetic fixture data (`DATA_SOURCE=fixture`) uses CMC-shaped ids from 990001 upwards and is
labelled synthetic everywhere; its LBank feed includes an explicit trading status so the
`VERIFIED` path can be demonstrated offline.

## Input acceptance gate (p.8) — how it is checked

| Check | Implementation |
|---|---|
| Daily rows are completed UTC days | parser keeps rows whose `timeClose` is before the crawl time; window dates end at T−1 |
| Current volume is rolling 24 h | listing `volume24h` is CMC's rolling 24 h total; no hourly volume is derived |
| Volume and cap from the same observation | both read from one `quotes[USD]` object; `current_status = MISMATCHED` exists for other sources |
| Provider update / crawl / scan time distinct | `observedAt`, `collectedAt`, `ScanResult.computedAt` |

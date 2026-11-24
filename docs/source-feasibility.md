# Market-data source feasibility

Website access verified 2026-11-03 (listing, daily history) and 2026-11-05 (LBank and asset
market pairs). The plan/terms comparison below is retained from the earlier assessment; it is
separate from the current collector's technical capabilities.

## Current implementation

The earlier claim that CoinMarketCap could not be crawled was a source-policy conclusion,
not a technical finding. The project supports the operator-requested website collector
explicitly (`DATA_SOURCE=coinmarketcap_web`, no key, no browser runtime). It is the only live
source that supplies everything Tier 1 of the Two-Tier VMC strategy needs:

| Tier 1 input (PDF p.8) | Website route (see [architecture.md § CMC website collection](architecture.md#cmc-website-collection)) |
|---|---|
| Rank, circulating cap, rolling-24h volume, price, update time, date added, tags | hourly listing, one `limit=10000` request |
| Completed UTC daily volume and market cap (30 days needed) | `v3.1/cryptocurrency/historical`, `interval=1d`, one request per screen candidate per UTC day |
| LBank Spot pairs mapped by CMC base-asset id (the Markets section of `coinmarketcap.com/exchanges/lbank/?type=spot`) | `v3/exchange/market-pairs/latest?slug=lbank&category=spot`, pages of 500; fetched once, then every 30 days or on demand |
| Asset venue rows (Upbit-dominant / single-venue flags) | `v3/cryptocurrency/market-pairs/latest`, top 100 spot pairs, review candidates only |
| *Not a Tier 1 input:* LBank Futures and Bithumb listings on the forward-test tab ([ADR-0007](adr/0007-exchange-listings.md)) | the same exchange route, `slug=lbank&category=perpetual` + `category=futures` and `slug=bithumb&category=spot` (verified 2026-11-17: 737 perpetuals, 0 dated futures, 497 Bithumb pairs, every pair with its CMC id); every `EXCHANGE_LISTS_REFRESH_HOURS` (24) |
| *Not a Tier 1 input:* the forward test's signal-day hourly Highs ([forward-test.md § 6](forward-test.md)) | the same history route, `interval=1h`, one request per coin and signal date whose daily High came before detection and was not reached later |

The daily history route also returns, per completed day, the OHLC High with its documented time
(`timeHigh`, `timeLow`, minute resolution); since M008 they are stored for the
[Star Event Forward Test](forward-test.md) (tracked coins that left the screen get the same
daily-history request).

**Hourly history (assessed 2026-11-18 for gap U1).** The same route and parameters with
`interval=1h` return hourly candles (`timeOpen` hh:00, `timeClose` hh:59:59.999, OHLC in USD with
`timeHigh` / `timeLow` at minute resolution). One request returns up to 400 hours ending at
`timeEnd` (10 Nov was still served on 18 Nov; history reaches back at least to 25 Oct). On the 32
coins of the first 37 `INCOMPLETE_DAY0` events, the largest of each date's 24 hourly Highs equalled
the stored daily High exactly, and its `timeHigh` the daily one to the minute: the same series at a
finer grain. `interval=15m` is also served (400 quarters, about 4 days per request), but its Highs
are *lower* than the hourly High in most hours (by up to 0.85 %), never higher — a coarser series,
not used. `interval=5m` answers `error_code 500` ("The system is busy"). Cost: about one request per
affected coin and signal date (the first update after deployment: about 290 for the open events),
within the shared rate limit, budget reserve and circuit breaker. Same access posture as the daily
route (operator-selected website collector, no supported API contract; Requirement 1).

**LBank Spot 1-minute candles (assessed 2026-11-24 for the
[LBank Spot Price Observation](lbank-spot-observation.md)).** Not a CMC route: LBank's official
public REST API, `GET https://api.lbkex.com/v2/kline.do?symbol=<pair>&size<=2000&type=minute1&time=<unix s>`
(host per LBank's 2023-08-07 API notice; the docs page still shows the old `api.lbank.info`). Verified
on real events: contiguous closed bars over full 168 h windows (6 requests each), history back years,
HIGH / LOW / CLOSE equal to LBank's own trades, OPEN = previous CLOSE, minutes without trades filled at
volume 0, the minute in progress included (dropped by server time), a time before listing answered
with the first bars, delisted pairs answered with error 10008, 200 requests / 10 s
(`X-LBank-RateLimit-*`). LBank's public Futures API has no history. Details and numbers:
[lbank-spot-observation.md § 3](lbank-spot-observation.md#3-data-source-report-b-feasibility-tested-2026-11-24-against-real-data).

What none of these routes supply: an LBank **trading status** (open / suspended / delisted), the
date a pair was listed, or a **sub-hourly** High with its time — so a forward-test event whose
detection hour's High came before detection, and was not reached later, can stay `INCOMPLETE_DAY0`
(forward-test.md § 14, U1). By operator decision D1 a pair in CMC's LBank Spot markets list counts
as tradable (a reviewer can mark it not tradable); `LBANK_REQUIRE_MANUAL_VERIFICATION=true`
instead requires a human check of every listed pair (strategy document, A7, D1, D2).

Other sources:
- `fixture` remains the offline default: a synthetic market (CMC-shaped ids ≥ 990001) with
  daily rows, LBank pairs (with an explicit trading status, to exercise the VERIFIED path) and
  venue rows, labelled SYNTHETIC everywhere.
- The official CoinMarketCap (`coinmarketcap`) and CoinGecko (`coingecko`) adapters remain as
  keyed **listing** sources. They implement no `Tier1Source`, so with them every VMC window is
  N/A (`DAILY_ROW_MISSING`) and every LBank status UNKNOWN: coins land in Needs Review and the
  queue is withheld. They are not a complete Tier 1 source.
- Manual CSV: `npm run cli -- daily:import-csv --id <cmcId> --file <download.csv>` imports the
  "Download CSV" export of a coin's CMC Historical Data page as completed daily rows (the open
  day is skipped; revisions are kept).

Website endpoints are not the supported Pro API contract and can change. This implementation does
not imply any change in CMC's website terms; source selection is explicit.

### Official CMC API (reference for a future keyed Tier 1 adapter)
Verified from the CMC API reference on 2026-11-03; not implemented for Tier 1. Header
`X-CMC_PRO_API_KEY` (never in a query string).

| Purpose | Endpoint | Plan availability (docs) |
|---|---|---|
| Daily rows (end-of-day quote) | `GET /v3/cryptocurrency/quotes/historical?interval=daily` (first quote of each UTC day → completed previous day; `volume_24h`, `market_cap`) | Basic: daily 1 year |
| Daily rows (OHLCV) | `GET /v2/cryptocurrency/ohlcv/historical?time_period=daily` | Startup+ documented; Basic ambiguous — probe first |
| Exchange market pairs | `GET /v1/exchange/market-pairs/latest` | plan-dependent (not verified) |
| Asset market pairs | `GET /v2/cryptocurrency/market-pairs/latest` | plan-dependent (not verified) |
| Identity | `GET /v1/cryptocurrency/map` | all plans, no credits |

The two daily conventions differ (rolling-24h volume sampled after midnight vs the completed
day's volume) and must never be mixed in one window. Errors: 401 auth, 402 billing, 403 plan
(1006), 429 rate limits (1008 per-minute; 1009/1010 daily/monthly exhaustion — not retried).

## Comparison

| Source | Automated access | Redistribution | Free limits | Fields | Free history | Coverage |
|---|---|---|---|---|---|---|
| CoinMarketCap website | **No** (terms) | No | – | – | – | – |
| **CoinMarketCap Basic API** | Yes (key, free) | Commercial use on free tier for one product; no resale or standalone redistribution | 15,000 credits/mo, 50 req/min | price, circ. mcap, 24h volume, supply, primary contract, tags | intraday ~1 month, daily ~1 year | ~8,000 active |
| CoinGecko website | **No** (terms; anti-bot challenge) | Screenshots only | – | – | – | – |
| **CoinGecko Demo API** | Yes (key, free) | Display with attribution; no re-distribution of API access; Demo not commercial | 100 calls/min, 10,000/mo | price, circ. mcap, 24h volume, supply, FDV; contracts via `/coins/list` | daily/hourly up to 1 year (plan table) | ~22,700 |
| CoinPaprika free API | API yes, website no | Personal use only | 20k calls/mo | price, mcap, volume, supply | limited | 2,000 assets |
| DefiLlama coins API | API yes, scraping no | "republish … without permission" prohibited | unspecified | price only | yes | needs chain:address |
| Binance public market data | Documented endpoints | Vision dumps CC BY-NC-SA, no signal distribution | weight 6,000/min | price, volume, bid/ask per pair; no mcap/supply | klines | Binance pairs only |
| CryptoCompare / CoinDesk | – | – | free tier retired 2026-05-21 | – | – | – |

### Key quotes
- CoinMarketCap terms (coinmarketcap.com/terms): may not use "any data mining, crawling,
  'scraping', robot or similar automated or data gathering or extraction method".
- CoinMarketCap API pricing FAQ: Basic "include[s] commercial use rights … you may not
  redistribute or resell it as a standalone service … must remain an integrated component of
  a larger product offering."
- CoinGecko terms (coingecko.com/en/terms): "you shall not … mine data from, scrape … including
  … any screen-scraper, hacks, spider, robot … without our prior written consent."
- CoinGecko API terms: not permitted to "sell, rent, lease, sub-license, re-distribute or
  syndicate access to the CoinGecko API"; attribution "Powered by CoinGecko"; "We do not
  encourage caching or storage of Data. However, if you must … refresh the cache at least
  every 24 hours."
- DefiLlama terms: may not "republish the data in any form without permission".
- Binance Vision terms: datasets under CC BY-NC-SA 4.0; not for "signal distribution to third
  parties".

Not verified (pages rendered behind bot challenges or missing): CMC commercial API user
agreement details, Binance main terms, CoinCap free tier.

## Request volume (website collector)
| Activity | Requests |
|---|---|
| Hourly listing | 1 per hour (~720/month), plus up to 3 re-reads in an hour whose listing gives one rank to two coins (CMC's rank cache read mid-refresh: 4 of the first 191 live hours, 2026-11-10 to 2026-11-18) |
| LBank Spot pairs | 2 requests per fetch (~900 pairs, overlapping pages), once every `LBANK_PAIRS_REFRESH_DAYS` (30) plus manual refreshes |
| Daily rows | ~1 per screen candidate per UTC day (ELIGIBLE coins since `vmc-tier1-2`, roughly 250–300), plus retries after `TIER1_DAILY_RETRY_HOURS` for coins whose latest day was not yet published |
| Signal-day hourly Highs (forward test) | ~1 per coin and signal date whose daily High came before detection and was not reached later (a share of each day's new events), retried within `MISSING_DATA_RETRY_DAYS` only while no capture matches |
| Venue rows | ≤ `TIER1_VENUE_MAX_ASSETS_PER_RUN` per run, each candidate at most every `TIER1_VENUE_REFRESH_HOURS` |
| LBank Spot candles (not CMC: LBank's own API, its own budget) | ~1 per active pair per hour (≈ 225 / h at today's event volume), ≤ 6 for a new window, plus 2–3 list requests per job run with new events |
| LBank Futures + Bithumb lists | ~4 per refresh (perpetual: 2 pages, futures: 1, Bithumb: 1), every `EXCHANGE_LISTS_REFRESH_HOURS` (24) plus `exchange-lists:refresh`; a failed attempt is retried after at most 6 h; skipped when the request reserve is reached |

At 30 requests/minute, 1,000 daily-history requests take about 33 minutes, so the first run
after a cold start spreads its daily refresh over two or three runs
(`TIER1_DAILY_MAX_MINUTES=30`); windows stay N/A until their days arrive. The local budget
`CMC_WEB_MONTHLY_REQUEST_BUDGET` (default 30,000) stops daily-history and venue requests before
it is exceeded, keeping 3 requests for every remaining hour of the month (listing + LBank pages).

## Access discipline (implemented in `PoliteHttpClient`)
Sequential requests (concurrency 1 per client), per-minute rate limit, monthly request budget
persisted in PostgreSQL, exponential backoff with jitter, Retry-After (seconds or HTTP date),
ETag conditional requests, circuit breaker (opens after repeated failures), and **suspension
after repeated 401/403** until a human runs `npm run cli -- source:reset`. Application-level
errors inside HTTP 200 are also checked. No proxy rotation, no identity rotation, no CAPTCHA
handling. "No bans" is not promised.

## Cost separation
| Cost | Item |
|---|---|
| Market data | $0 (fixture, website collector without a key, or free official API tiers with keys) |
| Model inference | none (no LLM is called) |
| Hosting | Your machine or a small VM + Docker (see `architecture.md` § Storage and retention) |
| Telegram | Bot API is free; subject to rate limits |

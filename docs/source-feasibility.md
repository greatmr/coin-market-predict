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

What none of these routes supply: an LBank **trading status** (open / suspended / delisted) or
the date a pair was listed. By operator decision D1 a pair in CMC's LBank Spot markets list counts
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
| Hourly listing | 1 per hour (~720/month) |
| LBank Spot pairs | 2 requests per fetch (~900 pairs, overlapping pages), once every `LBANK_PAIRS_REFRESH_DAYS` (30) plus manual refreshes |
| Daily rows | ~1 per screen candidate per UTC day (non-excluded coins, roughly 500–1,100), plus retries after `TIER1_DAILY_RETRY_HOURS` for coins whose latest day was not yet published |
| Venue rows | ≤ `TIER1_VENUE_MAX_ASSETS_PER_RUN` per run, each candidate at most every `TIER1_VENUE_REFRESH_HOURS` |

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

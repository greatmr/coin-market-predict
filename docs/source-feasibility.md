# Market-data source feasibility

Website access verified 2026-11-03. The plan/terms comparison below is retained from the
previous assessment; it is separate from the current collector's technical capabilities.

## Current implementation

The earlier claim that CoinMarketCap could not be crawled was a source-policy conclusion,
not a technical finding. On 2026-11-03, direct requests successfully retrieved the coin page's
embedded Next.js data and its website listing, daily history and seven-day chart endpoints.
The project now supports the operator-requested website collector explicitly:

- `DATA_SOURCE=coinmarketcap_web`: the full website listing (all ~8k coins, one `limit=10000`
  request per hour) into the analysis pipeline, plus seven-day chart history for coins that would
  be eligible but lack the previous hourly snapshots.
- `VMC_SOURCE=cmc_web`, `VMC_DAILY_CONVENTION=ohlcv`: coin pages, daily OHLCV baseline inputs,
  hourly chart backfill and current rolling-24h volume / market-cap snapshots.
- `fixture` remains the offline default. The official CoinMarketCap and CoinGecko adapters
  remain available as separate keyed sources.

No browser runtime or `nest-crawler` dependency is necessary. Website endpoints are not the
supported Pro API contract and can change. This implementation does not imply any change in
CMC's website terms; source selection is explicit. See [the implemented routes, request
behavior and commands](volume-mcap.md#9-no-key-website-crawler-and-manual-csv-import).

The supplied historical request's `interval=3d` failed with application error `500`,
`Unexpected value: 3d`, despite HTTP 200. `interval=1d` returned daily OHLCV data. The collector
also filters responses to the requested UTC date window because CMC returned extra dates.

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

## Selecting a source

Use `coinmarketcap_web` / `cmc_web` for the requested no-key website collection, or use the
existing official adapters with their keys. Choose monitored VMC numeric ids explicitly.
Requests, page limits and budgets bound coverage; every collector reports partial coverage
when it has not collected all reported assets. The website collector reads the complete listing
each hour; the official free API tiers remain partial by design. Market-analysis history accumulates hourly;
the separate VMC workflow can backfill its daily baseline and recent hourly comparison.

## Access discipline (implemented in `PoliteHttpClient`)
Sequential requests (concurrency 1 per client), per-minute rate limit, monthly request budget persisted in
PostgreSQL, exponential backoff with jitter, Retry-After (seconds or HTTP date), ETag
conditional requests, circuit breaker (opens after repeated failures), and **suspension after
repeated 401/403** until a human runs `npm run cli -- source:reset`. The website consumers share a client with a bounded 60-second cache and 30 requests/minute
by default (one every two seconds, strictly sequential); steady-state load is about one listing
request per hour plus a few chart requests, the first run's history backfill being the burst. Application-level errors inside HTTP 200 are also checked. No proxy rotation, no
identity rotation, no CAPTCHA handling. "No bans" is not promised.

## Cost separation
| Cost | Item |
|---|---|
| Market data | $0 (fixture, website collector without a key, or free official API tiers with keys) |
| Model inference | Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN` (usage limits apply); per-run and daily caps use the SDK's cost *estimate* (`total_cost_usd`) as a proxy |
| Hosting | Your machine or a small VM + Docker; with the default retention policy PostgreSQL holds a rolling ~6 GB of 30-day detail plus ~11 GB/year for the full ~8k-coin website universe (see `architecture.md` § Storage and retention) |
| Telegram | Bot API is free; subject to rate limits |

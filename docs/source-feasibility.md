# Market-data source feasibility

Checked 2026-11-03 against primary documents. Plans and terms change; re-check with the
`source-assessment` skill before enabling a live source. This is not legal advice.

## Conclusion
**No permitted website-scraping route provides the required fields.** CoinMarketCap,
CoinGecko, CoinPaprika and DefiLlama all prohibit automated collection from their websites.
The only permitted non-API datasets (Binance Vision dumps, Kaggle) lack circulating market cap,
supply and contracts, or are stale and individually licensed.

So the project ships:
- a **source-independent adapter interface** (`src/sources/types.ts`);
- a **synthetic fixture source** (default, labeled `isLive=false` everywhere);
- two **optional free official-API adapters** (CoinMarketCap Basic, CoinGecko Demo). These
  are proposed as an *alternative* to the requested scraping approach and are never enabled
  silently: they require `DATA_SOURCE=…` plus a free API key you obtain yourself.

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

## Recommendation
1. **Default: fixture mode** until you choose a source (unresolved decision #1 in `intend.md`).
2. **Live option A — CoinMarketCap Basic (recommended).** Commercial rights on the free tier,
   one call returns price/cap/volume/supply/contract. Budget: 1 credit per 200 listings; the
   defaults (`SOURCE_MAX_MARKET_PAGES_PER_RUN=10`) cover the top ~2,000 hourly (~7,300
   credits/month) — **partial coverage**, reported as such.
3. **Live option B — CoinGecko Demo.** Best contract coverage across chains; but non-commercial
   licence and the 24h cache-refresh clause conflict with a long-term archive. Obtain written
   permission before archiving or posting publicly.

## Access discipline (implemented in `PoliteHttpClient`)
Sequential requests (concurrency 1), per-minute rate limit, monthly request budget persisted in
PostgreSQL, exponential backoff with jitter, Retry-After (seconds or HTTP date), ETag
conditional requests, circuit breaker (opens after repeated failures), and **suspension after
repeated 401/403** until a human runs `npm run cli -- source:reset`. No proxy rotation, no
identity spoofing, no CAPTCHA handling. "No bans" is not promised.

## Cost separation
| Cost | Item |
|---|---|
| Market data | $0 (fixture, or free official API tiers; keys required) |
| Model inference | Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN` (usage limits apply); per-run and daily caps use the SDK's cost *estimate* (`total_cost_usd`) as a proxy |
| Hosting | Your machine or a small VM + Docker; PostgreSQL storage grows ~1–2 GB/year at 2,000 assets/hour |
| Telegram | Bot API is free; subject to rate limits |

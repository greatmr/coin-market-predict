# Test fixtures

`cmc-listings-latest.json`, `coingecko-markets.json` and `coingecko-list.json` are
**hand-written samples shaped after the providers' documented response schemas** (CoinMarketCap
v1 `listings/latest`, CoinGecko v3 `coins/markets` and `coins/list`). They are not captured live
responses and the numbers are not real market data. They exist so parser tests never hit live
endpoints.

When an adapter is first used live, save a small real response here (respecting the provider's
terms) and add a test against it, so schema drift is caught.

`cmc-history-litecoin.csv` is shaped like CoinMarketCap's "Download CSV" export of a coin's
Historical Data page (semicolon-delimited) and tests `daily:import-csv`. Dates, Volume and Market
Cap for 2026-10-22 .. 2026-11-02 are transcribed from the earlier brief's page-4 Litecoin
screenshot; Oct 22 high/low were obscured and are placeholders, and the 2026-11-03 row is an
invented incomplete day used to test that the current UTC day is skipped. The exact export header
was not verified against a real download — the parser is tolerant of `,`/`;`, quotes and header
naming.

## CMC website responses

Trimmed public responses from the website JSON routes used by Tier 1 — parser fixtures, not a
current market feed:

| File | Route | Captured | Trimmed to |
|---|---|---|---|
| `cmc-web-listing.json` | `/data-api/v3/cryptocurrency/listing` | 2026-11-03 | a small listing page |
| `cmc-web-history.json` | `/data-api/v3.1/cryptocurrency/historical` (XRP, id 52) | 2026-11-03 | four completed days |
| `cmc-web-lbank-pairs.json` | `/data-api/v3/exchange/market-pairs/latest?slug=lbank&category=spot` | 2026-11-05 | 5 of the 900 reported pairs (so a single page is correctly *incomplete*) |
| `cmc-web-market-pairs.json` | `/data-api/v3/cryptocurrency/market-pairs/latest` (Litecoin, id 2) | 2026-11-05 | 8 of the 500 reported pairs |

End-to-end and database tests use the synthetic `FixtureCmcMarket`
(`src/modules/sources/fixture/fixture-cmc.ts`): ids ≥ 990001, ranks 1–1300 plus one unranked coin, 29
named edge cases (exact 1.5×, missing / invalid days, zero baseline, stale and unverified quotes,
rank / cap / age boundaries, ambiguous LBank tickers, Upbit-dominant and single-venue coins).
Every value it produces is invented and labelled SYNTHETIC.

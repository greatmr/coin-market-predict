# Test fixtures

These JSON files are **hand-written samples shaped after the providers' documented response
schemas** (CoinMarketCap v1 `listings/latest` and `map`, CoinGecko v3 `coins/markets` and
`coins/list`). They are not captured live responses and the numbers are not real market data.
They exist so parser tests never hit live endpoints.

When an adapter is first used live, save a small real response here (respecting the provider's
terms) and add a test against it, so schema drift is caught.

`cmc-history-litecoin.csv` is shaped like CoinMarketCap's "Download CSV" export of a coin's
Historical Data page (semicolon-delimited). Dates, Volume and Market Cap for 2026-10-22 ..
2026-11-02 are transcribed from the brief's page-4 Litecoin screenshot; Oct 22 high/low were
obscured and are placeholders, and the 2026-11-03 row is an invented incomplete day used to test
that the current UTC day is skipped. The exact export header was not verified against a real
download — the parser is tolerant of `,`/`;`, quotes and header naming.

## CMC website responses

`cmc-web-coin.html`, `cmc-web-detail.json`, `cmc-web-history.json`, `cmc-web-chart.json`
and `cmc-web-listing.json` are trimmed public CMC responses captured on 2026-11-03 for XRP
(id 52) and a small listing page. The coin HTML retains the embedded JSON shape; unrelated
page content is omitted. History keeps four completed days; chart keeps sixteen samples.
These are parser fixtures, not a current market feed. Database website tests synthesize
response values to test full six-month windows and 72-hour persistence without networking.

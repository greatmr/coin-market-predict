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

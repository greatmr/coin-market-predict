# Test fixtures

These JSON files are **hand-written samples shaped after the providers' documented response
schemas** (CoinMarketCap v1 `listings/latest` and `map`, CoinGecko v3 `coins/markets` and
`coins/list`). They are not captured live responses and the numbers are not real market data.
They exist so parser tests never hit live endpoints.

When an adapter is first used live, save a small real response here (respecting the provider's
terms) and add a test against it, so schema drift is caught.

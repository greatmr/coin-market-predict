---
name: risk-review
description: Adversarial review checklist for a Coins Predicts signal — data quality, manipulation risk, liquidity, market-wide moves, and failure conditions. Use for every risk-reviewer verdict.
---

# Risk review checklist

For each analyst assessment, read the evidence pack and answer every question.

## Data quality
1. Is the latest observation fresh (`freshnessSeconds`, no `stale_observation` flag)?
2. Are price, circulating market cap, and rolling 24h volume all present? Is market cap
   `calculated_from_circulating_supply` rather than provider-reported?
3. Is the run's coverage `partial` (see `get_collection_health`)? The asset may be ranked
   against an incomplete universe.
4. Did the analyst cite values that exist in the pack with matching timestamps?
5. Do earlier hours come from the history backfill (`historical_backfill` in
   `get_asset_history`, `history` in `get_collection_health`)? Those are genuine chart samples
   taken at the same minute offset as the current snapshot, without circulating supply; an hour
   the chart lacked stays missing. Treat a short or gappy history as thin evidence.

## Manipulation and liquidity
6. `vol_mcap` above 1, `possible_wash_trading`, or `volume_exceeds_market_cap` → reject.
7. `price_up_without_volume` → the move lacks participation.
8. `micro_cap`, `large_fdv_overhang`, `no_liquidity_data` → fragile; slippage unknown.

## Context
9. Is this market beta (`rs_market_2h` small while the market median is up)?
10. Is it already extended (`move_underway`/`overextended`, large `provider_change_24h`)?
11. With only t, t−1h, t−2h snapshots, is the analyst over-reading three data points?

## Verdict
- `reject` for severe manipulation signs or unusable data.
- `downgrade` when the hypothesis is plausible but the evidence is thin.
- `agree` only when every check passes.
Always list concrete failure conditions, e.g. "next hourly snapshot below the invalidation
price" or "rolling 24h volume stops rising".

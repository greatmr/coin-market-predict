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

## Manipulation and liquidity
5. `vol_mcap` above 1, `possible_wash_trading`, or `volume_exceeds_market_cap` → reject.
6. `price_up_without_volume` → the move lacks participation.
7. `micro_cap`, `large_fdv_overhang`, `no_liquidity_data` → fragile; slippage unknown.

## Context
8. Is this market beta (`rs_market_2h` small while the market median is up)?
9. Is it already extended (`move_underway`/`overextended`, large `provider_change_24h`)?
10. With only t, t−1h, t−2h snapshots, is the analyst over-reading three data points?

## Verdict
- `reject` for severe manipulation signs or unusable data.
- `downgrade` when the hypothesis is plausible but the evidence is thin.
- `agree` only when every check passes.
Always list concrete failure conditions, e.g. "next hourly snapshot below the invalidation
price" or "rolling 24h volume stops rising".

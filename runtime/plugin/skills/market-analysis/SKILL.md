---
name: market-analysis
description: Procedure for interpreting a Coins Predicts evidence pack and classifying a shortlisted crypto asset as an advance signal, a move underway, a gradual trend, or market beta. Use for every market-analyst assessment.
---

# Market analysis procedure

Work asset by asset. For each one, read its evidence pack with `get_evidence`.

## 1. Check that the data is usable
- `warmupState`: `warming_up` → status `insufficient_data`. `limited` → statistical features
  (volatility, z-scores, breakouts) are unavailable; rely on the 3-snapshot heuristics only and
  say so.
- `latest.observedAt` vs `latest.collectedAt` (`freshnessSeconds`): stale data is not current.
- `latest.qualityFlags` and `nullReasons`: list missing fields in `dataQuality.missing`.
- Volume is a ROLLING 24h total (`volumeWindow`). `vol24_change_2h` is a change in that rolling
  total, not hourly volume. Never describe it as "volume in the last hour".

## 2. Separate a surge from ordinary appreciation
| Pattern | Typical evidence |
|---|---|
| Advance (early surge) | `vol24_change_2h` rising strongly, `accel_1h` > 0, `rs_market_2h` > 0, `ret_2h` still modest |
| Move underway | `ret_2h` already large (classification `move_underway`) — detection, not advance |
| Gradual trend | small positive returns, `accel_1h` ≈ 0, high `trend_persistence_12h`, no volume build |
| Market beta | `rs_market_2h` ≈ 0 while `market.marketMedianRet2h` is positive |
| Overextended | very large `ret_2h` or `provider_change_24h` |

## 3. Weigh counterevidence
Risk flags (`screening.riskFlags`) are counterevidence: `volume_exceeds_market_cap`,
`possible_wash_trading`, `price_up_without_volume`, `micro_cap`, `large_fdv_overhang`,
`provider_timing_mismatch`, `no_liquidity_data`, `thin_history`.

## 4. Decide
- `candidate` only for a clean advance pattern with good data and no severe risk flag.
- `watch` when the pattern is interesting but incomplete, underway, or risky.
- `no_signal` when the evidence does not support a surge hypothesis.
- `insufficient_data` when warm-up or missing fields prevent judgement.

## 5. Write the assessment
- Evidence: 2–5 items, each `{metric, value, observedAt, interpretation}` copied exactly.
- Counterevidence: the strongest reasons it may fail.
- Entry/invalidation/exit/expiry: from `scenario`, optionally stricter.
- Rationale: under 120 words, plain language, no promises.

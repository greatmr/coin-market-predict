# Strategy and its limitations

## What the screen looks for (`surge-screen-1`, feature set `fs-1`)
An **advance candidate** is an asset whose rolling-24h volume is building (`vol24_change_2h`),
whose price is accelerating (`accel_1h > 0`) while still modest (`ret_2h` below the
"underway" threshold), and that outperforms the market median (`rs_market_2h > 0`).
Other classes, kept separate:
- **move_underway** — already up ≥ 8% in 2h: *detection* of a move, not an advance signal.
- **gradual_trend** — small, steady positive returns with no acceleration or volume build
  (the "steady Apple-like climb").
- **market_wide** — moving with a broad rally, little relative strength.
- **overextended** — ≥ 25% in 2h or ≥ 60% in 24h.

Excluded before classification: stablecoins, wrapped/bridged/staked exposure, benchmark
references (BTC/ETH), stale or incomplete observations, illiquid (24h volume / market-cap
floors), missing circulating market cap, and warm-up.

## Features and data requirements
| Feature | Kind | Needs |
|---|---|---|
| `ret_1h`, `rs_btc_1h`, `rs_eth_1h`, `provider_change_1h_gap` | heuristic | 2 consecutive hourly snapshots |
| `ret_2h`, `accel_1h`, `vol24_change_2h`, `rs_market_2h` | heuristic | 3 (t, t−1h, t−2h) |
| `vol_mcap`, `provider_change_24h` | heuristic / provider | 1 snapshot with volume + circulating cap |
| `trend_persistence_12h` | statistical | 13 |
| `realized_vol_24h`, `ret_zscore_1h`, `breakout_24h` | statistical | 25 |
| `vol24_zscore_72h` | statistical | 73 |
| `spread_pct`, `est_slippage_pct` | liquidity | source-provided spread / depth (not available from listing endpoints → disabled) |

A missing hour or stale observation breaks the consecutive chain; features that need more
history are NULL with the reason, never estimated.

## Scores are not probabilities
`heuristicScore` (0–100) is a weighted, clipped ranking aid with penalties for risk flags. The
agent `score` is a heuristic conviction. No component produces a calibrated probability;
`Signal.calibratedProbability` stays NULL and backtests report calibration as "not
applicable". Agent agreement is not evidence of accuracy.

## Research target (`target-1`)
Hit = within 24h after the signal, observed at hourly snapshots, the asset gains ≥ 15% from the
reference price **and** beats the market median by ≥ 10 percentage points, **without** first
falling 7% or more. Outcomes are `pending` until the horizon passes and `insufficient_data`
with < 50% observation coverage or no benchmark.

## Paper scenario
Entry only if an hourly snapshot prints ≥ reference × (1 + 1%) (2% for moves underway) within 6h;
stop −7% from entry; target +15%; trailing stop 5% below the high-water mark after +8%; max hold
24h. Fees 10 bps and slippage 30 bps per side (configurable). Fills at the qualifying snapshot
price plus slippage; gaps through the stop exit at the observed price; targets never fill
better than the target; when a bar could contain both stop and target, the stop is assumed
first.

## Hourly observation limits
The system polls once per hour. It cannot see minute-scale pumps, intrahour highs/lows, or
whether a stop or target was touched between snapshots. Maximum adverse excursion is
understated. Reports and the dashboard state this; no continuous monitoring is implied.

## Three snapshots
With only t, t−1h, t−2h, the screen can measure 2-hour momentum, acceleration and volume build —
crude heuristics. "Candidate" status requires `CANDIDATE_MIN_HISTORY` (25) consecutive hours;
before that, signals are capped at `watch`.

## Evaluation
`npm run cli -- backtest` runs a time-ordered walk-forward evaluation on stored history:
point-in-time features (only data ≤ t), point-in-time universe (an asset must be observed at t),
outcomes labelled from future data only, one open position per asset, 72h folds, the last 20%
held out as an untouched test period (`--final-test` to evaluate it once). Baselines: top-K
2h momentum, BTC buy-and-hold, market median. Metrics: precision, false-positive rate, recall,
average/total net return, max drawdown, win rate. The agent layer is not replayed. With less
than 168h + horizon of history the report is "pending". Backtests on fixture data say nothing
about real markets.

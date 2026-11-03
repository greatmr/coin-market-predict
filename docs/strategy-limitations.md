# Strategy and its limitations

## What the screen looks for (`surge-screen-3`, feature set `fs-1`)
An **advance candidate** is an asset whose rolling-24h volume is building (`vol24_change_2h`),
whose price is accelerating (`accel_1h > 0`) while still modest (`ret_2h` below the
"underway" threshold), and that outperforms the market median (`rs_market_2h > 0`).
Other classes, kept separate:
- **move_underway** — already up ≥ 8% in 2h: *detection* of a move, not an advance signal.
- **gradual_trend** — small, steady positive returns with no acceleration or volume build
  (the "steady Apple-like climb").
- **market_wide** — moving with a broad rally, little relative strength.
- **overextended** — ≥ 25% in 2h or ≥ 60% in 24h.

Excluded before classification: stablecoins, tokenized off-chain assets (stocks, ETFs,
commodities, treasuries), wrapped/bridged/staked exposure, benchmark references (BTC/ETH), stale
or incomplete observations, illiquid (24h volume / market-cap floors), missing circulating market
cap, and warm-up. `surge-screen-2` added the tokenized class: on the 2026-11-03 listing, 103
tokenized stocks and 16 tokenized ETFs/gold coins sat inside the floors and move with equities
and gold rather than crypto.

How a coin's class is decided (`src/ingestion/classify.ts`, only ever made stricter):
provider tags (`stablecoin`/`*-stablecoin`, `wrapped-tokens`, `tokenized-stock|etfs|commodities|
gold|silver|treasury-*|real-estate`), then name heuristics (wrapped/bridged/staked/stablecoin
symbols), then price evidence: a coin priced within 0.9–1.4× of BTC, ETH, SOL or BNB *and* naming
that asset (wstETH, LBTC, BTCB, slisBNBx…), or a USD-named coin pinned to $1. Ambiguous tags are
not used alone: `liquid-staking-derivatives`/`restaking` also tag LDO, RPL or PENDLE, and
`stablecoin-protocol` tags governance tokens.

## Pump chance and recommendations (`surge-screen-3`)
Every screened coin gets a **pump chance** — a heuristic level from the deterministic screen,
never a probability (`src/screening/recommend.ts`):

| Level | Rule |
|---|---|
| high | advance candidate with heuristic score ≥ 50 |
| medium | advance candidate below 50; move underway with score ≥ 50 (late, chasing risk); or a forming setup — 3 of the 4 early-surge conditions (volume build ≥ 15%, acceleration > 0, 2h return ≥ +0.5%, ahead of the market median) with score ≥ `minShortlistScore` |
| low | everything else, and any coin flagged for wash trading or 24h volume above market cap |

Each level carries plain-language reasons (conditions met ✓ / missed ✗, cautions). The pump
watchlist is the top `RECOMMENDATIONS_MAX` (10) eligible coins by chance then score; the top
`SHORTLIST_SIZE` (6) of those (high, or medium with score ≥ 35) go to the agents.

For the watchlist the `vmc` stage fetches each coin's six-month daily volume / market cap baseline
(two website requests per new coin, refreshed weekly) so every row shows the current ratio, the
baseline and the multiple, plus the last three days of stored hourly prices (change, high, low).

Agents analyse the shortlist with that context and give their **own stance**: `buy` (take the
paper long only if the entry trigger prints), `hold` (wait for confirmation) or `sell` (avoid or
exit). Code then combines strategy, guardrails and agents into **Buy / Watch / Avoid**: Buy only
when the pump chance is high or medium, the guardrailed status is `candidate` and the agents say
buy; any agent sell, review rejection, low chance or missing data is Avoid; everything else is
Watch. `candidate` itself now requires the base strategy's advance pattern. All of this is paper
trading research: no orders exist, and a "Buy" is a hypothesis to test, not advice.

## Universe and history
Every listed coin is collected each hour (the website listing returns all ~8k coins in one
request). The **screen universe** is benchmarks plus non-excluded coins with circulating market
cap ≥ the floor; only these get feature and screening rows. Coins outside it are stored as raw
snapshots and summarized as exclusion counts per run. The market median uses the same universe
(non-stale), so it reflects ~1,000+ coins rather than whichever coins happened to have history.

A coin that would be eligible but lacks t−1h/t−2h (first run, newly qualifying, or after
downtime) gets one chart request: genuine samples for the previous 72 hours, each hour taken at
the same minute offset as the current snapshot so t, t−1h, t−2h are about an hour apart. Hours the
chart lacks stay missing. The backfill is bounded per run (coins, minutes, monthly-request
reserve) and resumes next run; meanwhile every coin also accumulates its own hourly snapshots.

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
before that, signals are capped at `watch`. Coins with a genuine 72-hour backfill meet this on
their first screened hour; coins that only warm up from hourly collection need 25 hours.

## Evaluation
`npm run cli -- backtest` runs a time-ordered walk-forward evaluation on stored history:
point-in-time features (only data ≤ t), point-in-time universe (an asset must be observed at t),
outcomes labelled from future data only, one open position per asset, 72h folds, the last 20%
held out as an untouched test period (`--final-test` to evaluate it once). Baselines: top-K
2h momentum, BTC buy-and-hold, market median. Metrics: precision, false-positive rate, recall,
average/total net return, max drawdown, win rate. The agent layer is not replayed. With less
than 168h + horizon of history the report is "pending". Backtests on fixture data say nothing
about real markets.

# Coins Predicts — intent

## Purpose
Every hour, collect cryptocurrency market snapshots, keep their history, compute quantitative
features, and flag assets that may be starting an **unusual, rapid upward move** — as opposed
to ordinary gradual appreciation (the "steady Apple-like climb") or a broad market rally.
Shortlisted assets are reviewed by Claude agents; results go to a dashboard and a Telegram
channel. Every output is a **testable research hypothesis**, evaluated by paper trading.

## Requirements
1. **Sources**: no paid market-data subscriptions. Support the explicitly selected CMC website collector and public
   datasets; no CAPTCHA bypass or evasive proxies. Free
   official APIs only as an explicit, opt-in alternative.
2. **Universe**: target every token the selected source lists; paginate; canonical identity by
   provider id and chain + contract (never symbol alone); honest coverage reporting.
3. **Snapshots**: "three historical records" = hourly snapshots at t, t−1h, t−2h
   (`SNAPSHOT_WINDOW`, configurable). Retain longer history. Backfill only from real
   historical observations; otherwise warm up over time.
4. **Semantics**: UTC storage; USD price; circulating market cap (never FDV); rolling 24h
   volume kept separate from hourly volume; nulls carry reasons; quality/freshness flags.
5. **Pipeline**: hourly, non-overlapping across instances, bounded retries, idempotent writes,
   restart recovery, Telegram retries independent of collection/analysis.
6. **Screening**: deterministic for all eligible assets; exclude stablecoins, wrapped, illiquid,
   stale, incomplete, and overextended; heuristic scores ≠ probabilities.
7. **Agents**: Claude Agent SDK; coordinator + market analyst + risk reviewer; role-based
   models with escalation; budgets, timeouts, caching; validated structured outputs.
8. **Delivery**: dashboard + MCP server; Telegram compact ranked report with dry-run mode.
9. **Evaluation**: time-ordered backtest and paper trading, no look-ahead, fees/slippage,
   baselines, pending when history is insufficient.

10. **Volume / Market Cap baseline** (CMC brief, `docs/volume-mcap.md`): for explicitly
    configured CoinMarketCap ids, a weekly six-month baseline = arithmetic mean of valid daily
    volume ÷ market-cap ratios, a one-time 72 h hourly backfill, hourly rolling-24h snapshots,
    and a descriptive comparison (no thresholds or recommendations).

## Assumptions
- Single operator, personal research use; one deployment.
- Hourly cadence is acceptable; minute-scale moves are out of reach.
- `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, ~1 year validity) belongs to the
  operator's own Claude subscription and is used only server-side for this personal tool.
- Display timezone Asia/Tehran (configurable).

## Constraints
- The CMC website collector uses page data and website JSON endpoints with no supported API
  contract. It is explicitly selected by the operator and may break if CMC changes access.
- Free API tiers cannot sweep every listed token every hour; coverage is partial by design.
- The Agent SDK docs state third parties may not offer claude.ai login/rate limits to *their*
  users without approval; this project must not be offered to others on the operator's token.

## Non-goals
- Real order placement, brokerage integration, or portfolio management.
- Guaranteed pumps, profit claims, exact entry/exit times, or calibrated probabilities
  (until a calibration model exists and is validated).
- Intrahour monitoring, order-book trading, or minute-level signals.
- Multi-tenant SaaS.

## Acceptance criteria
- `npm test` and `npm run test:db` pass offline; fixture mode runs end to end
  (fixture ingestion → PostgreSQL → features → agents → signals → dashboard/MCP → Telegram dry run).
- Fixture data is labeled as synthetic everywhere it appears (DB flag, dashboard, Telegram).
- Coverage is never labeled complete unless every listed asset was collected.
- Agents run with no built-in tools, only role-scoped read MCP tools, explicit runtime skills,
  and an allowlisted environment; structured outputs validated; guardrails cap statuses.
- Telegram live delivery only with `TELEGRAM_MODE=live` and valid credentials.
- Backtest reports "pending" when history is insufficient; never invented results.

## Unresolved decisions (owner: operator)
1. **Live data source.** Implemented choices: fixture, explicitly selected CMC website collector
   (`DATA_SOURCE=coinmarketcap_web`, `VMC_SOURCE=cmc_web`, no key), or official keyed APIs.
   The website page/history/chart/listing routes were verified live on 2026-11-03.
2. **Coverage vs cadence.** The website collector reads the full universe (~8k coins) hourly in
   one listing request. Free official API tiers fit roughly the top 2,000–3,000 assets hourly
   (hourly-partial) — choose that or full-universe every few hours if you switch to an API.
3. **Redistribution in Telegram.** Summary signals are lower-risk than bulk data tables; confirm
   the provider's terms for the channel's audience (private vs public).
4. **Candidate threshold.** `CANDIDATE_MIN_HISTORY=25` hours before any "candidate"; revisit
   after real history accumulates and backtests exist.
5. **Calibrated probabilities.** Not produced. Revisit only with enough labeled outcomes.
6. **Volume / Market Cap universe and plan.** `VMC_ASSET_IDS` is empty until you choose ids
   (examples: 1 BTC, 1027 ETH, 2 LTC). Use the no-key website collector or a CoinMarketCap API key; run `vmc:probe`
   to confirm the selected source's access (Basic documents daily 1 year / intraday 1 month for
   quotes/historical; OHLCV access on Basic is ambiguous). Display beyond dashboard/CLI/file and
   any comparison threshold are undecided (PDF p.8).
7. **Storage retention.** Default `RETENTION_DETAIL_DAYS=30`: after 30 days, coins outside the
   strategy floors keep one snapshot per UTC day; strategy-universe coins stay hourly. Set `0` to
   keep all hourly detail (~60 GB/year of snapshots at the full universe).

---
name: data-quality-review
description: Checklist for reviewing collection health and data quality of recent Coins Predicts runs (coverage, staleness, missing fields, source circuit state, warm-up). Use when runs look partial, signals look odd, or before trusting backtest results.
---

# Data-quality review

Use the read-only MCP server (`coins-predicts` in `.mcp.json`) or the dashboard API.

1. `get_run_status`: recent runs — any `failed`, `missed`, or repeated `partial`? Which stage?
2. `get_coverage`: provider live vs fixture; last discovery complete?; coverage label and
   percentage; circuit state (`open`/`suspended` → stop and investigate the cause before
   `npm run cli -- source:reset`); monthly budget used.
3. Missing fields (`lastRunCoverage.missingFields`): spikes in `marketCap`, `observedAt`, or
   `volumeRolling24h` usually mean a provider schema change — check parser tests.
4. Staleness: stale count vs. collected; compare `observedAt` with `collectedAt` on a few
   `get_snapshots` results.
5. Warm-up: `get_features` → `historyDepth`/`warmupState`. Statistical features need 25–73
   consecutive hours; gaps reset the chain.
6. Identity: spot-check `list_assets` for duplicate symbols mapped to one asset (should not
   happen) or one asset split across ids without contract links.
7. Summarize findings with run ids and timestamps; do not edit data in place — fix the code
   path and let the next run write correct rows.

---
name: data-quality-review
description: Checklist for reviewing collection health and data quality of recent Coins Predicts runs (crawl batch completeness, stale quotes, missing fields, daily-row coverage, LBank feed, source circuit state). Use when runs look partial, the Review Queue is withheld or looks odd, or before trusting a scan.
---

# Data-quality review

Use the read-only MCP server (`coins-predicts` in `.mcp.json`), the dashboard API, or the CLI
(`tier1:batches`, `tier1:trace --id <cmcId>`).

1. `get_run_status`: recent runs — any `failed`, `missed`, or repeated `partial`? Read
   `metrics.degraded` (batch status, LBank feed, daily rows partial, export failure).
2. `list_batches`: batch status COMPLETE / INCOMPLETE / FAILED; `missingRanks` and
   `duplicateRanks` within 1–1200; listed vs collected. INCOMPLETE withholds the queue.
3. `get_coverage`: provider live vs fixture; circuit state (`open`/`suspended` → stop and
   investigate the cause before `npm run cli -- source:reset`); monthly request budget used vs
   `CMC_WEB_MONTHLY_REQUEST_BUDGET`.
4. Missing fields (`CrawlBatch.fieldCounts`): spikes in null `rank`, `dateAdded`, `marketCap`,
   `observedAt` or `volumeRolling24h` usually mean a provider schema change — check parser tests.
5. `get_scan_summary`: counts of current-quote statuses (`STALE`, `TIMESTAMP_UNVERIFIED`), N/A
   reasons per window (`DAILY_ROW_MISSING` spikes → daily stage bounded, budget, or CMC delay),
   LBank status counts and the LBank crawl status; warnings (incomplete universe, missing daily
   data vs earlier batch, stale-quote spike, empty venue mapping, open mapping tasks).
6. `get_asset_trace` for a few queue and needs-review coins: dates and values of each window,
   daily revisions ("revised since scan"), provider update vs crawl time, LBank evidence.
7. Identity: spot-check `list_assets` / `get_mapping_tasks` for one ticker on several CMC ids or
   symbol mismatches; never resolve by symbol — record a reviewer decision or an override.
8. Summarize findings with batch ids and timestamps; do not edit data in place — fix the code
   path (or record a reviewer decision) and let the next scan write correct rows.

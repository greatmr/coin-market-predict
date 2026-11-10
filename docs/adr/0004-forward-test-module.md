# ADR-0004 — The Star Event Forward Test is a module beside the strategy

**Status:** Accepted, 2026-11-10 (operator handoff "Star Event Forward Test", 10 Nov 2026).

## Context
The forward test records each first priced 1/2/3-star detection and measures the highest future
High until the end of the UTC day containing detection + 168 h ([forward-test.md](../forward-test.md)).
It consumes Tier 1 results but must not change any Tier 1 rule, and it needs its own rules (event
key, window, High eligibility, state machine, cohort statistics), storage, schedule and outputs.

## Decision
- `src/modules/forward-test/` is a module of its own, not part of `modules/strategy`:
  - `forward.constants.ts` (`FORWARD_RULES_VERSION`, value sets mirrored by PostgreSQL enums,
    reason codes) and `forward-rules.ts` / `cohort.ts`: pure functions without I/O, unit-tested
    with the handoff's acceptance cases, the same discipline as the strategy module;
  - services for the trigger (`ForwardCaptureService`), the daily update
    (`ForwardUpdateService`), reads (`ForwardReadService`), exports (`ForwardExportService`) and
    the pipeline entry point (`ForwardTestService`).
- It uses the strategy only through `modules/strategy/index.js` (status sets, `StrategyService`
  for the quote-age limit) and reads Tier 1 results from the database. A forward-test rule change
  bumps `FORWARD_RULES_VERSION`, stored on every event and outcome version, never
  `RULESET_VERSION`.
- It attaches to the hourly pipeline as the last stage (`forward`, after `notify`): no second
  scanner or scheduler, the same lease, non-fatal. Reprocessing never triggers it.
- The only change outside the module's tables is the targeted High capture: `timeHigh` / `timeLow`
  kept by the existing daily-history parser and stored on `daily_metric_revision` (outside its
  content hash), and the existing daily refresh reused for tracked coins.
- HTTP routes stay in `modules/dashboard` (`ForwardController`); MCP and the CLI use
  `ForwardReadService`.

## Consequences
- \+ The Tier 1 ruleset, scan results and their lineage are untouched; the add-on can be versioned
  and audited on its own.
- \+ Its rules run without a database, like the strategy's.
- − The pipeline has nine stages; the dashboard step bar and stage tests list `forward`.
- − Forward-test statuses advance at the daily update, not continuously.

## Alternatives rejected
- **Rules inside `modules/strategy`**: every forward-test change would bump the Tier 1 ruleset
  version and appear in every scan result's lineage.
- **A separate daily cron job**: a second scheduler and lease for work the hourly run can do once
  per closed day, with the same retry behaviour.
- **Foreign keys to `scan_result`**: reprocessing replaces scan rows; events keep a copy of the
  published row and reference the crawl batch instead.

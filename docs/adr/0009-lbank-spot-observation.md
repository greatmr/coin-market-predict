# ADR-0009 — LBank Spot Price Observation replaces the forward test for new events

**Status:** Accepted, 2026-11-24 (operator request: "LBank Spot Price Observation page"; the new
tracker gets its own tables, backend and page; the legacy forward test finishes its own events).
**Amended 2026-11-25 by [ADR-0010](0010-lbank-observation-v2.md)** (rules `lbank-spot-obs-2`): the
window starts at the proven publication instead of the crawl time, the reference is the first
verified trade instead of a candle OPEN, and the extremes are verified trades. The measurement
bullet below describes rules v1 (kept as audit values).

## Context

The Star Event Forward Test ([ADR-0004](0004-forward-test-module.md)) measures the highest CMC daily
High against the CMC price at detection, to the end of the UTC day containing t0 + 168 h. The
operator wants, for new CMC star events, the rise **and** the fall of the **LBank Spot** price over
**exactly** t0 + 168 h, with LBank as the only price source, Spot / Futures eligibility judged at the
signal, and a clean cutover: no event in both trackers, none in neither, legacy events finished under
their own rules and then the legacy tracker retired.

## Decision

- **A neutral star-event layer** (`modules/star-events/`): the existing event rule (`validateTrigger`,
  the published-queue reader) moves there unchanged and both trackers use it; the legacy module
  re-exports it. `signal_cutover` holds one cutover per provider.
- **The cutover is a UTC midnight**, set ahead of now and of every stored batch, immutable once
  passed. Because the event key contains the UTC date, no key can straddle the trackers, so routing
  is a pure function of a sighting's detection time. Triggers refuse a legacy event at or after the
  cutover and a new event before it.
- **A new module with its own tables** (`modules/lbank-observation/`, migration M015):
  `lbank_obs_event` (immutable events by the same rule), `lbank_observation` (one per event, unique
  foreign key), shared `lbank_spot_candle` per (pair, minute), evidence fetch log, append-only
  results, intake and job runs. The `observe` pipeline stage only records events; candles, evidence
  and results come from the module's own job (own cron and lease), so LBank never slows the CMC run.
- **Source: LBank's official public REST API** (`api.lbkex.com`, per LBank's endpoint notice):
  verified on real events to serve contiguous, exact 1-minute history far beyond 168 h, with the
  documented rate limit; stored bars only once closed, exact digits, immutable. No WebSocket, no
  third-party feed, no CMC price in any LBank number.
- **Measurement rules** (v1, superseded by ADR-0010) in pure functions with a version (`lbank-spot-obs-1`): entry = OPEN of the
  first bar opening at or after t0 (≤ 2 min, not stale); extremes from bars with trades only, never
  from the bar straddling the cutoff; explicit statuses; FINAL only with full coverage after the
  window; statistics from FINAL observations only, with event and coin denominators.
- **Eligibility from evidence around the signal**: Spot from the candles themselves and LBank's list
  near t0; Futures only when CMC's list before t0 and LBank's contract list after t0 agree; UNKNOWN
  otherwise.
- **Legacy wind-down**: explicit terminal closures (FINAL / INCOMPLETE / DATA_UNAVAILABLE with
  reasons), automatic retirement report when all are terminal after the cutover; the update job
  stops and the page leaves the navigation; data and exports stay.

## Consequences

- \+ The two trackers share one event definition and can never both own an event (database-level).
- \+ LBank numbers are reproducible: exact bars, rules version, series hash on each final result.
- − A second scheduled job, and ~35 MB/day of candles (bounded by `LBANK_CANDLE_RETENTION_DAYS`).
- − Futures status at an earlier time cannot be proven from LBank itself (no history): UNKNOWN is
  common when evidence on either side is missing.
- − The cutover can only start at a UTC midnight at least 2 h ahead.

## Alternatives rejected

- **Routing flag on `forward_event`** (new events in the legacy table): couples the new tracker to
  legacy columns (end-of-day window, legacy statuses) and puts post-cutover events into the legacy
  table; the operator asked for new tables.
- **A non-midnight cutover with a cross-table duplicate check**: a key of one UTC date could have
  sightings on both sides; the check would need locking across tables.
- **Storing seven days of candles per event**: 4.5× the rows for overlapping events; refused by the
  request.
- **LBank WebSocket collection**: only collects from the connection time, needs reconnect and gap
  recovery by REST anyway; REST alone covers history and gaps.
- **TradingView or undocumented chart endpoints**: not a data API / not permitted as a dependency.

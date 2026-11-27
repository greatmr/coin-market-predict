# ADR-0013: Observation freshness, request lanes and the indicative Spot quote

Status: accepted (2026-11-27)

## Context
A review of the deployed Futures observed-quote method (ADR-0011 addendum) found five gaps:

1. An open page did not refresh for Futures-only updates: its change token read only Spot rows and
   Spot job runs (11:52 UTC Futures evaluation vs 11:47 UTC token).
2. One label, "sampled through", meant our response receipt for new rows and LBank's snapshot refresh
   time for old rows.
3. Spot verification and Futures requests share one FIFO LBank client: minute samples waited up to
   1.498 s behind the 11:45 Spot job. The publication quote had not been measured under load, and a
   same-moment Spot comparison at publication did not exist.
4. Compare showed Spot verified extremes (data ~60–75 min behind) next to Futures sampled extremes
   (through the last minute) with no coverage times.
5. Old-method Futures rows needed an explicit statement of what their records can and cannot prove.

## Decision
- **Change tokens split by venue** (`version()`): `spotToken` (job runs, Spot rows) reloads rows and
  summary; `futuresToken` reloads only the rows. Futures changes are detected by
  `lbank_futures_observation.values_changed_at`, set by a database trigger only when a displayed value
  differs (M020) — a trigger, so no writer can forget it and a no-op re-evaluation never moves it —
  plus the latest stored quote, order book and indicative Spot quote. Tokens are read before the data.
  Open dialogs reload through an in-page notice (no polling of their own).
- **Time bases named, never converted.** The API and CSV expose `observedThrough` (our receipt,
  quote-1) and `lbankSnapshotThrough` (LBank `lastTime`, old method) separately with `throughBasis`;
  the ambiguous `futures_sampled_through_utc` column is removed. Stored values are untouched.
- **Request lanes in the polite client**, not a second client: one pacing (`LBANK_REQUESTS_PER_MINUTE`),
  budget, circuit and Retry-After stay shared. Lanes only order waiting requests: `immediate`
  (publication quotes, retries) → `prompt` (minute samples, order books) → `routine`. An immediate
  request may run alongside one in-flight request (max two), so it waits for the pacing only; retries
  back off outside the queue; Retry-After blocks all lanes; a routine request goes after 8 consecutive
  urgent grants. Health updates are serialized (overlapping requests would otherwise lose budget and
  failure counts). Rejected: per-host clients (would double the request rate the operator configured
  and split the budget and circuit); preempting in-flight requests (impossible without concurrency).
- **Indicative Spot quote at publication**: LBank's all-pairs Spot price request queued with the
  Futures quote (Futures first: it is the reference), stored in its own immutable tables
  (`lbank_spot_price_request`, `lbank_spot_indicative_quote`). Never the Spot reference, a return, an
  extreme, a status or coverage input; never retried later. The pacing puts it ≥ 1 interval after the
  Futures request; both requests' times and the difference are shown, never called simultaneous.
- **Coverage times** per row (Spot candles through, Futures through in its own basis, difference,
  `differs` beyond one minute as a display cue only) in Compare ("Status · data through") and Details;
  Compare heads the extremes "Spot verified · Fut sampled". The order book shows its own time and its
  delay after the quote.
- **Evidence classes** computed at read time from existing records (rules version, entry source, first
  stored request, whether the first response after the start was kept): only `IMMEDIATE_QUOTE` is an
  immediate Futures entry; old-method rows are classed `LEGACY_BEFORE_COLLECTION`,
  `LEGACY_FIRST_RESPONSE_RETAINED`, `LEGACY_FIRST_RESPONSE_LOST` or `LEGACY_UNRESOLVED` and never pooled
  with new ones. Nothing is backfilled or rewritten.

## Consequences
- An open page shows a Futures-only change within one 30 s check plus load time; while windows run
  the rows reload about once a minute (one list request; the summary only on Spot changes).
- The routine Spot job can be delayed by the few urgent requests per hour (about one pacing interval
  each); it is never stopped.
- No rules version changes: Spot (`lbank-spot-obs-2`) and Futures (`lbank-futures-quote-1`) values
  are computed exactly as before.
- Docs: `docs/lbank-spot-observation.md` § 13b.

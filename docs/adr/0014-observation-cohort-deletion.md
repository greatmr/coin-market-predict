# ADR-0014: Deleting an observation cohort

Status: accepted (2026-11-27)

## Context
The operator asked to delete every LBank observation (Spot and Futures) of the CMC crawl batches up
to and including the 2026-11-27 11:07 UTC batch (14:37 Asia/Tehran): those events were measured under
superseded methods (Futures turnover brackets, missing early samples, the earlier freshness and queue
behaviour). Later batches must stay exactly as they are, and nothing may recreate the deleted rows.

## Decision
- **Membership by batch identity and stored crawl time** (`crawl_batch.crawled_at` ≤ the cutoff
  batch's, checked to equal each event's `detected_at`), never by window start, reference time, rules
  version or a label. One crawl per minute was verified.
- **One audited script, one transaction** (`scripts/db/2026-11-27-delete-observation-cohort.sql`):
  explicit target tables, expected counts, a full-row fingerprint of every surviving row before and
  after, a CSV export of exactly the deleted rows from the same snapshot, and the append-only triggers
  disabled only inside the transaction. Any difference rolls everything back. No cascade exists in the
  observation schema (all foreign keys RESTRICT), so nothing else can be removed implicitly.
- **Raw data by readability, not by ownership alone.** Rows a surviving observation can read are kept
  (its pair's Spot series, its contract's samples from its start, every request since the earliest
  surviving start); raw rows only the deleted cohort could read are removed. A Spot pair whose series
  is removed gets `synced_until` reset, because a missing candle before `synced_until` means "LBank
  answered without a candle".
- **Never recreated** (M021): the deleted batches are skipped by the intake, and the deleted keys stay
  taken (`lbank_obs_deleted_key`, BEFORE INSERT trigger skips the row) so a later same-day sighting is
  ignored as the original's duplicate would have been. Rejected: freeing the keys, which would turn a
  repeat sighting into a new event that would never have existed.
- **Recovery** only from the backups (full dump + targeted CSV), each restored in an isolated database
  before the deletion; never restored over production.

## Consequences
- The page, Details, API, CSV and statistics show only later batches; the summary and the CLI name the
  deletion (`deletions`), and the routing check counts the deleted batches as accounted for.
- No rule, window, sampler cadence or calculation changed; later events are measured as before.

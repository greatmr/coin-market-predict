-- One-time, operator-approved deletion (2026-11-27; docs/lbank-spot-observation.md § 13c, ADR-0013
-- addendum): every LBank observation, Spot AND Futures, of the CMC crawl batches up to and INCLUDING the
-- cutoff batch, plus the raw rows that only those observations could read. Nothing of a later batch
-- is touched; CMC source data (crawl batches, snapshots, scans, queues, reviews) stays.
--
-- Membership = crawl batch identity and its stored crawl time (crawl_batch.crawled_at <= the cutoff
-- batch's): never the window start, a reference time, a rules version or a display label.
--
--   cd <empty export dir> && psql -v ON_ERROR_STOP=1 -v cutoff=<batch uuid> -v backup='<full dump path>' \
--        -v expect_batches=N -v expect_events=N -v expect_results=N -v expect_rules=N \
--        -v expect_refs=N -v expect_books=N -v expect_quotes=N -f 2026-11-27-delete-observation-cohort.sql
--
-- Deleted (one transaction, REPEATABLE READ; any unexpected count, a changed survivor or a dangling
-- reference raises: ROLLBACK, nothing deleted):
--   events, Spot observations, results, rules-change audit rows, indicative Spot quotes, Futures
--   observations, Futures references and order books, intake runs of the target batches;
--   Futures samples no surviving observation can read (contract not observed by a survivor, or the
--   request was sent before that contract's earliest surviving start) and Futures requests sent before
--   the earliest surviving start; Spot candles / trades / trade-minute checks of pairs no remaining
--   observation uses — with those pairs' synced_until reset to never-synced (a missing candle before
--   synced_until reads as "LBank answered without a candle", so the two change together).
-- Recorded: lbank_obs_cohort_deletion (counts, backup), lbank_obs_deleted_batch, lbank_obs_deleted_key
-- (the deleted keys stay taken: a later sighting is ignored as the original's duplicate would have been).
-- Exported first, from the same snapshot: exactly the deleted rows (and the pairs' old sync state) as CSV
-- into the working directory — the targeted recovery set; the full dump :backup is the complete one.

\set ON_ERROR_STOP on
\timing on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '600s';
-- Locks before the snapshot: writers of these tables wait until COMMIT (the sampler, the job, intake).
LOCK TABLE lbank_obs_event, lbank_observation, lbank_futures_observation, lbank_obs_intake_run,
           lbank_spot_pair, lbank_spot_candle, lbank_spot_trade, lbank_spot_trade_minute
  IN SHARE ROW EXCLUSIVE MODE;
-- Append-only guards that also refuse DELETE: disabled for this transaction only (DDL is
-- transactional; they are enabled again below before COMMIT, so no other session sees them off).
ALTER TABLE lbank_futures_book DISABLE TRIGGER lbank_futures_book_immutable;
ALTER TABLE lbank_futures_reference DISABLE TRIGGER lbank_futures_reference_earliest;
ALTER TABLE lbank_observation_result DISABLE TRIGGER lbank_observation_result_immutable;
ALTER TABLE lbank_obs_rules_change DISABLE TRIGGER lbank_obs_rules_change_append_only;
ALTER TABLE lbank_futures_sample DISABLE TRIGGER lbank_futures_sample_immutable;
ALTER TABLE lbank_futures_poll DISABLE TRIGGER lbank_futures_poll_immutable;

-- ── Targets ──────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE cut ON COMMIT DROP AS
  SELECT id, provider_id, crawled_at FROM crawl_batch WHERE id = :'cutoff';
DO $$ BEGIN
  IF (SELECT count(*) FROM cut) <> 1 THEN RAISE EXCEPTION 'cutoff batch not found'; END IF;
  -- One crawl per minute assumption checked: no other batch shares the cutoff's crawl minute.
  IF EXISTS (SELECT 1 FROM crawl_batch b, cut WHERE b.id <> cut.id AND b.provider_id = cut.provider_id
               AND date_trunc('minute', b.crawled_at) = date_trunc('minute', cut.crawled_at)) THEN
    RAISE EXCEPTION 'another batch shares the cutoff minute: order by batch, not by minute';
  END IF;
  -- Batch identity and stored crawl time agree for every event (targets and survivors).
  IF EXISTS (SELECT 1 FROM lbank_obs_event e JOIN crawl_batch b ON b.id = e.source_batch_id
              WHERE e.detected_at <> b.crawled_at) THEN
    RAISE EXCEPTION 'an event''s crawl time differs from its batch''s';
  END IF;
END $$;

CREATE TEMP TABLE t_batch ON COMMIT DROP AS
  SELECT b.id, b.crawled_at FROM crawl_batch b, cut
   WHERE b.provider_id = cut.provider_id AND b.crawled_at <= cut.crawled_at
     AND (EXISTS (SELECT 1 FROM lbank_obs_event e WHERE e.source_batch_id = b.id)
          OR EXISTS (SELECT 1 FROM lbank_obs_intake_run i WHERE i.batch_id = b.id));
CREATE TEMP TABLE t_event ON COMMIT DROP AS
  SELECT e.id, e.provider_id, e.cmc_id, e.detected_utc_date, e.star_count, e.source_batch_id
    FROM lbank_obs_event e WHERE e.source_batch_id IN (SELECT id FROM t_batch);
CREATE TEMP TABLE t_obs ON COMMIT DROP AS
  SELECT o.id FROM lbank_observation o WHERE o.event_id IN (SELECT id FROM t_event);
CREATE TEMP TABLE t_fut ON COMMIT DROP AS
  SELECT f.id FROM lbank_futures_observation f WHERE f.observation_id IN (SELECT id FROM t_obs);

-- What survivors can read: per contract, requests sent at or after its earliest surviving start.
CREATE TEMP TABLE s_contract ON COMMIT DROP AS
  SELECT f.contract, min(o.observation_start) AS start
    FROM lbank_futures_observation f JOIN lbank_observation o ON o.id = f.observation_id
   WHERE f.id NOT IN (SELECT id FROM t_fut) AND f.contract IS NOT NULL GROUP BY 1;
CREATE TEMP TABLE s_start ON COMMIT DROP AS
  SELECT min(observation_start) AS at FROM lbank_observation WHERE id NOT IN (SELECT id FROM t_obs);
CREATE TEMP TABLE t_sample ON COMMIT DROP AS
  SELECT s.contract, s.server_at FROM lbank_futures_sample s
    LEFT JOIN lbank_futures_poll p ON p.id = s.poll_id LEFT JOIN s_contract c ON c.contract = s.contract
   WHERE c.contract IS NULL OR p.request_started_at IS NULL OR p.request_started_at < c.start;
CREATE TEMP TABLE t_poll ON COMMIT DROP AS
  SELECT p.id FROM lbank_futures_poll p, s_start
   WHERE s_start.at IS NOT NULL AND coalesce(p.request_started_at, p.fetched_at) < s_start.at;
-- Spot pairs no remaining observation uses (their per-pair series served only the deleted cohort).
CREATE TEMP TABLE t_pair ON COMMIT DROP AS
  SELECT p.id FROM lbank_spot_pair p
   WHERE NOT EXISTS (SELECT 1 FROM lbank_observation o WHERE o.pair_id = p.id AND o.id NOT IN (SELECT id FROM t_obs));

SELECT 'targets' AS what,
  (SELECT count(*) FROM t_batch) batches, (SELECT count(*) FROM t_event) events, (SELECT count(*) FROM t_obs) observations,
  (SELECT count(*) FROM t_fut) futures, (SELECT count(*) FROM t_sample) samples, (SELECT count(*) FROM t_poll) polls,
  (SELECT count(*) FROM t_pair) pairs, (SELECT at FROM s_start) earliest_surviving_start,
  (SELECT crawled_at FROM cut) cutoff_crawled_at;

-- Expected counts (the dry run's; they cannot grow: the target batches are closed).
CREATE TEMP TABLE expect ON COMMIT DROP AS SELECT
  :expect_batches::bigint AS batches, :expect_events::bigint AS events, :expect_results::bigint AS results,
  :expect_rules::bigint AS rules, :expect_refs::bigint AS refs, :expect_books::bigint AS books,
  :expect_quotes::bigint AS quotes;
DO $$ BEGIN
  IF (SELECT count(*) FROM t_batch) <> (SELECT batches FROM expect) THEN RAISE EXCEPTION 'batch count changed'; END IF;
  IF (SELECT count(*) FROM t_event) <> (SELECT events FROM expect) THEN RAISE EXCEPTION 'event count changed'; END IF;
  IF (SELECT count(*) FROM t_obs) <> (SELECT events FROM expect) THEN RAISE EXCEPTION 'observation count differs'; END IF;
  IF (SELECT count(*) FROM t_fut) <> (SELECT events FROM expect) THEN RAISE EXCEPTION 'Futures row count differs'; END IF;
  IF (SELECT count(*) FROM lbank_observation_result WHERE observation_id IN (SELECT id FROM t_obs)) <> (SELECT results FROM expect) THEN RAISE EXCEPTION 'result count changed'; END IF;
  IF (SELECT count(*) FROM lbank_obs_rules_change WHERE observation_id IN (SELECT id FROM t_obs)) <> (SELECT rules FROM expect) THEN RAISE EXCEPTION 'rules-change count changed'; END IF;
  IF (SELECT count(*) FROM lbank_futures_reference WHERE futures_observation_id IN (SELECT id FROM t_fut)) <> (SELECT refs FROM expect) THEN RAISE EXCEPTION 'reference count changed'; END IF;
  IF (SELECT count(*) FROM lbank_futures_book WHERE futures_observation_id IN (SELECT id FROM t_fut)) <> (SELECT books FROM expect) THEN RAISE EXCEPTION 'book count changed'; END IF;
  IF (SELECT count(*) FROM lbank_spot_indicative_quote WHERE observation_id IN (SELECT id FROM t_obs)) <> (SELECT quotes FROM expect) THEN RAISE EXCEPTION 'indicative quote count changed'; END IF;
  -- Nothing a survivor references may be a target.
  IF EXISTS (SELECT 1 FROM lbank_futures_reference r WHERE r.poll_id IN (SELECT id FROM t_poll)
              AND r.futures_observation_id NOT IN (SELECT id FROM t_fut)) THEN RAISE EXCEPTION 'a surviving reference uses a target request'; END IF;
  IF EXISTS (SELECT 1 FROM lbank_futures_sample s WHERE s.poll_id IN (SELECT id FROM t_poll)
              AND (s.contract, s.server_at) NOT IN (SELECT contract, server_at FROM t_sample)) THEN RAISE EXCEPTION 'a kept sample uses a target request'; END IF;
  IF EXISTS (SELECT 1 FROM lbank_spot_indicative_quote q JOIN lbank_spot_price_request r ON r.id = q.request_id
              WHERE q.observation_id NOT IN (SELECT id FROM t_obs) AND r.batch_id IN (SELECT id FROM t_batch)) THEN RAISE EXCEPTION 'a survivor uses a target batch request'; END IF;
END $$;

-- ── Survivors' fingerprint (full rows), before ─────────────────────────────────────────────
CREATE TEMP VIEW survivor_fp AS
  SELECT 'lbank_obs_event' AS t, count(*) AS n, md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), '')) AS fp
    FROM lbank_obs_event x WHERE x.id NOT IN (SELECT id FROM t_event)
  UNION ALL SELECT 'lbank_observation', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_observation x WHERE x.id NOT IN (SELECT id FROM t_obs)
  UNION ALL SELECT 'lbank_observation_result', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_observation_result x WHERE x.observation_id NOT IN (SELECT id FROM t_obs)
  UNION ALL SELECT 'lbank_obs_rules_change', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_obs_rules_change x WHERE x.observation_id NOT IN (SELECT id FROM t_obs)
  UNION ALL SELECT 'lbank_spot_indicative_quote', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_spot_indicative_quote x WHERE x.observation_id NOT IN (SELECT id FROM t_obs)
  UNION ALL SELECT 'lbank_spot_price_request', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_spot_price_request x
  UNION ALL SELECT 'lbank_futures_observation', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_futures_observation x WHERE x.id NOT IN (SELECT id FROM t_fut)
  UNION ALL SELECT 'lbank_futures_reference', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_futures_reference x WHERE x.futures_observation_id NOT IN (SELECT id FROM t_fut)
  UNION ALL SELECT 'lbank_futures_book', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_futures_book x WHERE x.futures_observation_id NOT IN (SELECT id FROM t_fut)
  UNION ALL SELECT 'lbank_obs_intake_run', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_obs_intake_run x WHERE x.batch_id NOT IN (SELECT id FROM t_batch)
  UNION ALL SELECT 'lbank_futures_sample (kept)', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.contract, x.server_at), ''))
    FROM lbank_futures_sample x WHERE (x.contract, x.server_at) NOT IN (SELECT contract, server_at FROM t_sample)
  UNION ALL SELECT 'lbank_futures_poll (kept)', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_futures_poll x WHERE x.id NOT IN (SELECT id FROM t_poll)
  UNION ALL SELECT 'lbank_spot_pair (used)', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.id), ''))
    FROM lbank_spot_pair x WHERE x.id NOT IN (SELECT id FROM t_pair)
  UNION ALL SELECT 'lbank_spot_candle (used pairs)', count(*), md5(coalesce(string_agg(x.pair_id || ':' || x.open_time::text || ':' || x.close::text, '|' ORDER BY x.pair_id, x.open_time), ''))
    FROM lbank_spot_candle x WHERE x.pair_id NOT IN (SELECT id FROM t_pair)
  UNION ALL SELECT 'lbank_spot_trade (used pairs)', count(*), md5(coalesce(string_agg(x.pair_id || ':' || x.trade_id || ':' || x.price::text, '|' ORDER BY x.pair_id, x.trade_id), ''))
    FROM lbank_spot_trade x WHERE x.pair_id NOT IN (SELECT id FROM t_pair)
  UNION ALL SELECT 'lbank_spot_trade_minute (used pairs)', count(*), md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.pair_id, x.minute_at), ''))
    FROM lbank_spot_trade_minute x WHERE x.pair_id NOT IN (SELECT id FROM t_pair);
CREATE TEMP TABLE fp_before ON COMMIT DROP AS SELECT * FROM survivor_fp;

-- ── Targeted recovery export (exactly the rows deleted below, same snapshot) ───────────────
\copy (SELECT x.* FROM lbank_obs_event x WHERE x.id IN (SELECT id FROM t_event) ORDER BY x.id) TO 'lbank_obs_event.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_observation x WHERE x.id IN (SELECT id FROM t_obs) ORDER BY x.id) TO 'lbank_observation.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_observation_result x WHERE x.observation_id IN (SELECT id FROM t_obs) ORDER BY x.id) TO 'lbank_observation_result.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_obs_rules_change x WHERE x.observation_id IN (SELECT id FROM t_obs) ORDER BY x.id) TO 'lbank_obs_rules_change.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_spot_indicative_quote x WHERE x.observation_id IN (SELECT id FROM t_obs) ORDER BY x.id) TO 'lbank_spot_indicative_quote.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_futures_observation x WHERE x.id IN (SELECT id FROM t_fut) ORDER BY x.id) TO 'lbank_futures_observation.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_futures_reference x WHERE x.futures_observation_id IN (SELECT id FROM t_fut) ORDER BY x.id) TO 'lbank_futures_reference.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_futures_book x WHERE x.futures_observation_id IN (SELECT id FROM t_fut) ORDER BY x.id) TO 'lbank_futures_book.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_obs_intake_run x WHERE x.batch_id IN (SELECT id FROM t_batch) ORDER BY x.id) TO 'lbank_obs_intake_run.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_futures_poll x WHERE x.id IN (SELECT id FROM t_poll) ORDER BY x.id) TO 'lbank_futures_poll.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_futures_sample x WHERE (x.contract, x.server_at) IN (SELECT contract, server_at FROM t_sample) ORDER BY x.contract, x.server_at) TO 'lbank_futures_sample.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_spot_candle x WHERE x.pair_id IN (SELECT id FROM t_pair) ORDER BY x.pair_id, x.open_time) TO 'lbank_spot_candle.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_spot_trade x WHERE x.pair_id IN (SELECT id FROM t_pair) ORDER BY x.pair_id, x.trade_id) TO 'lbank_spot_trade.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_spot_trade_minute x WHERE x.pair_id IN (SELECT id FROM t_pair) ORDER BY x.pair_id, x.minute_at) TO 'lbank_spot_trade_minute.csv' WITH (FORMAT csv, HEADER)
\copy (SELECT x.* FROM lbank_spot_pair x WHERE x.id IN (SELECT id FROM t_pair) ORDER BY x.id) TO 'lbank_spot_pair.before.csv' WITH (FORMAT csv, HEADER)

-- ── Record the deletion (counts = the targets; each DELETE below must remove exactly these) ──
CREATE TEMP TABLE planned ON COMMIT DROP AS SELECT
  (SELECT count(*) FROM t_batch) AS batches,
  (SELECT count(*) FROM t_event) AS events,
  (SELECT count(*) FROM t_obs) AS observations,
  (SELECT count(*) FROM lbank_observation_result WHERE observation_id IN (SELECT id FROM t_obs)) AS results,
  (SELECT count(*) FROM lbank_obs_rules_change WHERE observation_id IN (SELECT id FROM t_obs)) AS rules_changes,
  (SELECT count(*) FROM lbank_spot_indicative_quote WHERE observation_id IN (SELECT id FROM t_obs)) AS indicative_quotes,
  (SELECT count(*) FROM t_fut) AS futures_observations,
  (SELECT count(*) FROM lbank_futures_reference WHERE futures_observation_id IN (SELECT id FROM t_fut)) AS futures_references,
  (SELECT count(*) FROM lbank_futures_book WHERE futures_observation_id IN (SELECT id FROM t_fut)) AS futures_books,
  (SELECT count(*) FROM lbank_obs_intake_run WHERE batch_id IN (SELECT id FROM t_batch)) AS intake_runs,
  (SELECT count(*) FROM t_sample) AS futures_samples,
  (SELECT count(*) FROM t_poll) AS futures_requests,
  (SELECT count(*) FROM lbank_spot_candle WHERE pair_id IN (SELECT id FROM t_pair)) AS spot_candles,
  (SELECT count(*) FROM lbank_spot_trade WHERE pair_id IN (SELECT id FROM t_pair)) AS spot_trades,
  (SELECT count(*) FROM lbank_spot_trade_minute WHERE pair_id IN (SELECT id FROM t_pair)) AS spot_trade_minutes,
  (SELECT count(*) FROM t_pair) AS spot_pairs_reset;
INSERT INTO lbank_obs_cohort_deletion (provider_id, through_batch_id, through_crawled_at, reason, counts, backup)
  SELECT cut.provider_id, cut.id, cut.crawled_at,
         'Operator request 2026-11-27: delete every LBank observation (Spot and Futures) of the CMC crawl batches up to and including the cutoff batch (crawled 2026-11-27 11:07 UTC = 14:37 Asia/Tehran); later batches kept.',
         to_jsonb(planned), :'backup'
    FROM cut, planned;
INSERT INTO lbank_obs_deleted_batch (batch_id, deletion_id, events)
  SELECT b.id, (SELECT max(id) FROM lbank_obs_cohort_deletion), (SELECT count(*) FROM t_event e WHERE e.source_batch_id = b.id)
    FROM t_batch b;
INSERT INTO lbank_obs_deleted_key (provider_id, cmc_id, detected_utc_date, star_count, event_id, batch_id)
  SELECT provider_id, cmc_id, detected_utc_date, star_count, id, source_batch_id FROM t_event;

-- ── Delete, child tables first; every count checked ───────────────────────────────────────
CREATE TEMP TABLE done (t text, n bigint) ON COMMIT DROP;
WITH d AS (DELETE FROM lbank_futures_book WHERE futures_observation_id IN (SELECT id FROM t_fut) RETURNING 1) INSERT INTO done SELECT 'futures_books', count(*) FROM d;
WITH d AS (DELETE FROM lbank_futures_reference WHERE futures_observation_id IN (SELECT id FROM t_fut) RETURNING 1) INSERT INTO done SELECT 'futures_references', count(*) FROM d;
WITH d AS (DELETE FROM lbank_futures_observation WHERE id IN (SELECT id FROM t_fut) RETURNING 1) INSERT INTO done SELECT 'futures_observations', count(*) FROM d;
WITH d AS (DELETE FROM lbank_spot_indicative_quote WHERE observation_id IN (SELECT id FROM t_obs) RETURNING 1) INSERT INTO done SELECT 'indicative_quotes', count(*) FROM d;
WITH d AS (DELETE FROM lbank_observation_result WHERE observation_id IN (SELECT id FROM t_obs) RETURNING 1) INSERT INTO done SELECT 'results', count(*) FROM d;
WITH d AS (DELETE FROM lbank_obs_rules_change WHERE observation_id IN (SELECT id FROM t_obs) RETURNING 1) INSERT INTO done SELECT 'rules_changes', count(*) FROM d;
WITH d AS (DELETE FROM lbank_observation WHERE id IN (SELECT id FROM t_obs) RETURNING 1) INSERT INTO done SELECT 'observations', count(*) FROM d;
WITH d AS (DELETE FROM lbank_obs_event WHERE id IN (SELECT id FROM t_event) RETURNING 1) INSERT INTO done SELECT 'events', count(*) FROM d;
WITH d AS (DELETE FROM lbank_obs_intake_run WHERE batch_id IN (SELECT id FROM t_batch) RETURNING 1) INSERT INTO done SELECT 'intake_runs', count(*) FROM d;
WITH d AS (DELETE FROM lbank_futures_sample WHERE (contract, server_at) IN (SELECT contract, server_at FROM t_sample) RETURNING 1) INSERT INTO done SELECT 'futures_samples', count(*) FROM d;
WITH d AS (DELETE FROM lbank_futures_poll WHERE id IN (SELECT id FROM t_poll) RETURNING 1) INSERT INTO done SELECT 'futures_requests', count(*) FROM d;
WITH d AS (DELETE FROM lbank_spot_trade_minute WHERE pair_id IN (SELECT id FROM t_pair) RETURNING 1) INSERT INTO done SELECT 'spot_trade_minutes', count(*) FROM d;
WITH d AS (DELETE FROM lbank_spot_trade WHERE pair_id IN (SELECT id FROM t_pair) RETURNING 1) INSERT INTO done SELECT 'spot_trades', count(*) FROM d;
WITH d AS (DELETE FROM lbank_spot_candle WHERE pair_id IN (SELECT id FROM t_pair) RETURNING 1) INSERT INTO done SELECT 'spot_candles', count(*) FROM d;
WITH d AS (UPDATE lbank_spot_pair SET synced_until = NULL WHERE id IN (SELECT id FROM t_pair) RETURNING 1) INSERT INTO done SELECT 'spot_pairs_reset', count(*) FROM d;

ALTER TABLE lbank_futures_book ENABLE TRIGGER lbank_futures_book_immutable;
ALTER TABLE lbank_futures_reference ENABLE TRIGGER lbank_futures_reference_earliest;
ALTER TABLE lbank_observation_result ENABLE TRIGGER lbank_observation_result_immutable;
ALTER TABLE lbank_obs_rules_change ENABLE TRIGGER lbank_obs_rules_change_append_only;
ALTER TABLE lbank_futures_sample ENABLE TRIGGER lbank_futures_sample_immutable;
ALTER TABLE lbank_futures_poll ENABLE TRIGGER lbank_futures_poll_immutable;

-- ── Checks: planned = deleted; nothing targeted left; survivors identical ───────────────────
SELECT d.t, d.n AS deleted, (to_jsonb(p) ->> d.t)::bigint AS planned FROM done d, planned p ORDER BY d.t;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM done d, planned p WHERE d.n <> (to_jsonb(p) ->> d.t)::bigint) THEN
    RAISE EXCEPTION 'a delete removed a different number of rows than planned';
  END IF;
  IF EXISTS (SELECT 1 FROM lbank_obs_event e JOIN crawl_batch b ON b.id = e.source_batch_id, cut WHERE b.crawled_at <= cut.crawled_at)
     OR EXISTS (SELECT 1 FROM lbank_observation o JOIN lbank_obs_event e ON e.id = o.event_id JOIN crawl_batch b ON b.id = e.source_batch_id, cut WHERE b.crawled_at <= cut.crawled_at)
     OR EXISTS (SELECT 1 FROM lbank_obs_intake_run i JOIN crawl_batch b ON b.id = i.batch_id, cut WHERE b.crawled_at <= cut.crawled_at) THEN
    RAISE EXCEPTION 'targeted rows remain';
  END IF;
  IF EXISTS (SELECT 1 FROM lbank_obs_event e LEFT JOIN lbank_observation o ON o.event_id = e.id WHERE o.id IS NULL) THEN
    RAISE EXCEPTION 'an event without observation would be reconciled back';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT * FROM survivor_fp EXCEPT SELECT * FROM fp_before) x)
     OR EXISTS (SELECT 1 FROM (SELECT * FROM fp_before EXCEPT SELECT * FROM survivor_fp) y) THEN
    RAISE EXCEPTION 'a surviving row changed';
  END IF;
END $$;
SELECT t, n, fp FROM fp_before ORDER BY t;
SELECT id, deleted_at, through_batch_id, through_crawled_at, counts FROM lbank_obs_cohort_deletion ORDER BY id DESC LIMIT 1;
COMMIT;

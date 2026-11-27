-- RECOVERY PROCEDURE for the 2026-11-27 cohort deletion — for an ISOLATED copy of the database only
-- (never run against production without a separate operator decision). Loads the targeted CSV export
-- written by 2026-11-27-delete-observation-cohort.sql back into a database restored from the
-- pre-deletion dump and then rehearsal-deleted, and prints the fingerprints of the reloaded rows so they
-- can be compared with the export's own (the deletion script prints them as 'target').
--   cd <export dir> && psql -v ON_ERROR_STOP=1 -f 2026-11-27-restore-observation-cohort.isolated.sql
\set ON_ERROR_STOP on
BEGIN;
-- Stored values come back exactly: the deleted-key guard and the change stamp stay off while loading.
ALTER TABLE lbank_obs_event DISABLE TRIGGER lbank_obs_event_deleted_key;
ALTER TABLE lbank_futures_observation DISABLE TRIGGER lbank_futures_observation_values_changed;
\copy lbank_obs_intake_run FROM 'lbank_obs_intake_run.csv' WITH (FORMAT csv, HEADER)
\copy lbank_obs_event FROM 'lbank_obs_event.csv' WITH (FORMAT csv, HEADER)
\copy lbank_observation FROM 'lbank_observation.csv' WITH (FORMAT csv, HEADER)
\copy lbank_observation_result FROM 'lbank_observation_result.csv' WITH (FORMAT csv, HEADER)
\copy lbank_obs_rules_change FROM 'lbank_obs_rules_change.csv' WITH (FORMAT csv, HEADER)
\copy lbank_spot_indicative_quote FROM 'lbank_spot_indicative_quote.csv' WITH (FORMAT csv, HEADER)
\copy lbank_futures_observation FROM 'lbank_futures_observation.csv' WITH (FORMAT csv, HEADER)
\copy lbank_futures_poll FROM 'lbank_futures_poll.csv' WITH (FORMAT csv, HEADER)
\copy lbank_futures_sample FROM 'lbank_futures_sample.csv' WITH (FORMAT csv, HEADER)
\copy lbank_futures_reference FROM 'lbank_futures_reference.csv' WITH (FORMAT csv, HEADER)
\copy lbank_futures_book FROM 'lbank_futures_book.csv' WITH (FORMAT csv, HEADER)
\copy lbank_spot_candle FROM 'lbank_spot_candle.csv' WITH (FORMAT csv, HEADER)
\copy lbank_spot_trade FROM 'lbank_spot_trade.csv' WITH (FORMAT csv, HEADER)
\copy lbank_spot_trade_minute FROM 'lbank_spot_trade_minute.csv' WITH (FORMAT csv, HEADER)
CREATE TEMP TABLE pair_before (LIKE lbank_spot_pair) ON COMMIT DROP;
\copy pair_before FROM 'lbank_spot_pair.before.csv' WITH (FORMAT csv, HEADER)
UPDATE lbank_spot_pair p SET synced_until = b.synced_until FROM pair_before b WHERE p.id = b.id;
ALTER TABLE lbank_obs_event ENABLE TRIGGER lbank_obs_event_deleted_key;
ALTER TABLE lbank_futures_observation ENABLE TRIGGER lbank_futures_observation_values_changed;
COMMIT;

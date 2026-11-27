import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M021: the record of an operator-approved deletion of an LBank observation cohort, and the guard that
 * keeps it deleted (docs/lbank-spot-observation.md § 13c). Adds tables and a trigger only; the deletion
 * itself is a separate, audited one-time script (scripts/db/2026-11-27-delete-observation-cohort.sql).
 *  - `lbank_obs_cohort_deletion`: one row per deletion run: the inclusive cutoff batch, when, why, the
 *    per-table counts removed and where the recovery backup is. Immutable.
 *  - `lbank_obs_deleted_batch`: the crawl batches whose observations were deleted. The intake skips
 *    them (a forced re-run of an old slot never reopens their events). Immutable.
 *  - `lbank_obs_deleted_key`: the deleted events' keys (provider, CMC id, UTC date, stars). A later
 *    sighting of such a key is ignored exactly as the duplicate of the original event would have been
 *    (first insert wins), so the deletion changes no later event; new keys are unaffected. Immutable.
 */
export class M021ObservationCohortDeletion1793923200021 implements MigrationInterface {
  name = 'M021ObservationCohortDeletion1793923200021';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE lbank_obs_cohort_deletion (
  id                 BIGSERIAL NOT NULL,
  provider_id        text NOT NULL,
  through_batch_id   uuid NOT NULL,
  through_crawled_at timestamptz NOT NULL,
  deleted_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason             text NOT NULL,
  counts             jsonb NOT NULL DEFAULT '{}',
  backup             text NOT NULL,
  CONSTRAINT lbank_obs_cohort_deletion_pkey PRIMARY KEY (id),
  CONSTRAINT lbank_obs_cohort_deletion_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider(id) ON DELETE RESTRICT,
  CONSTRAINT lbank_obs_cohort_deletion_through_batch_id_fkey FOREIGN KEY (through_batch_id) REFERENCES crawl_batch(id) ON DELETE RESTRICT
)`);
    await q.query(`CREATE TABLE lbank_obs_deleted_batch (
  batch_id    uuid NOT NULL,
  deletion_id bigint NOT NULL,
  events      integer NOT NULL,
  CONSTRAINT lbank_obs_deleted_batch_pkey PRIMARY KEY (batch_id),
  CONSTRAINT lbank_obs_deleted_batch_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch(id) ON DELETE RESTRICT,
  CONSTRAINT lbank_obs_deleted_batch_deletion_id_fkey FOREIGN KEY (deletion_id) REFERENCES lbank_obs_cohort_deletion(id) ON DELETE RESTRICT
)`);
    await q.query(`CREATE TABLE lbank_obs_deleted_key (
  provider_id       text NOT NULL,
  cmc_id            integer NOT NULL,
  detected_utc_date date NOT NULL,
  star_count        integer NOT NULL,
  event_id          uuid NOT NULL,
  batch_id          uuid NOT NULL,
  CONSTRAINT lbank_obs_deleted_key_pkey PRIMARY KEY (provider_id, cmc_id, detected_utc_date, star_count),
  CONSTRAINT lbank_obs_deleted_key_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES lbank_obs_deleted_batch(batch_id) ON DELETE RESTRICT
)`);
    for (const t of [
      'lbank_obs_cohort_deletion',
      'lbank_obs_deleted_batch',
      'lbank_obs_deleted_key',
    ])
      await q.query(
        `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION lbank_futures_immutable()`,
      );
    // A deleted key stays taken: the insert is skipped (the intake counts it as already recorded).
    await q.query(`CREATE FUNCTION lbank_obs_event_deleted_key() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM lbank_obs_deleted_key k
              WHERE k.provider_id = NEW.provider_id AND k.cmc_id = NEW.cmc_id
                AND k.detected_utc_date = NEW.detected_utc_date AND k.star_count = NEW.star_count) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_obs_event_deleted_key BEFORE INSERT ON lbank_obs_event FOR EACH ROW EXECUTE FUNCTION lbank_obs_event_deleted_key()`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER lbank_obs_event_deleted_key ON lbank_obs_event`);
    await q.query(`DROP FUNCTION lbank_obs_event_deleted_key()`);
    await q.query(`DROP TABLE lbank_obs_deleted_key`);
    await q.query(`DROP TABLE lbank_obs_deleted_batch`);
    await q.query(`DROP TABLE lbank_obs_cohort_deletion`);
  }
}

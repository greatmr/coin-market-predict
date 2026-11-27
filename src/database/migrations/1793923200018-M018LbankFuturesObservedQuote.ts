import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M018: LBank Futures observed-quote method (rules `lbank-futures-quote-1`, docs § 13, ADR-0011
 * addendum). Adds, never rewrites: no Spot table is touched, no Futures row or sample is changed.
 *  - `lbank_futures_poll`: request trigger (TICK / PUBLICATION / RETRY), attempt number, queue and
 *    actual send times, endpoint, the published batch, the raw response (gzip; publication and retry
 *    requests) and the storage time. Existing rows were minute ticks (trigger TICK); their send and
 *    storage times were not recorded and stay NULL;
 *  - `lbank_futures_sample`: the request that returned the snapshot and its storage time (NULL on
 *    existing rows);
 *  - `lbank_futures_observation`: when the highest / lowest observed price was received;
 *  - `lbank_futures_reference`: the chosen observed quotes (ENTRY, POST_FIX), earliest receipt only
 *    (an update may only move a row to an earlier response; no delete);
 *  - `lbank_futures_book`: order-book context (immutable).
 */
export class M018LbankFuturesObservedQuote1793923200018 implements MigrationInterface {
  name = 'M018LbankFuturesObservedQuote1793923200018';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE lbank_fut_request_trigger AS ENUM ('PUBLICATION', 'RETRY', 'TICK')`);
    await q.query(`CREATE TYPE lbank_fut_reference_kind AS ENUM ('ENTRY', 'POST_FIX')`);

    await q.query(
      `ALTER TABLE lbank_futures_poll ADD trigger lbank_fut_request_trigger NOT NULL DEFAULT 'TICK'`,
    );
    await q.query(`ALTER TABLE lbank_futures_poll ADD attempt integer NOT NULL DEFAULT '1'`);
    await q.query(`ALTER TABLE lbank_futures_poll ADD request_queued_at timestamptz`);
    await q.query(`ALTER TABLE lbank_futures_poll ADD request_started_at timestamptz`);
    await q.query(`ALTER TABLE lbank_futures_poll ADD endpoint text`);
    await q.query(`ALTER TABLE lbank_futures_poll ADD batch_id uuid`);
    await q.query(`ALTER TABLE lbank_futures_poll ADD body_gzip bytea`);
    // NULL on existing rows (never recorded); new rows get the insert time.
    await q.query(`ALTER TABLE lbank_futures_poll ADD stored_at timestamptz`);
    await q.query(
      `ALTER TABLE lbank_futures_poll ALTER COLUMN stored_at SET DEFAULT clock_timestamp()`,
    );
    await q.query(`CREATE INDEX ix_lbank_futures_poll_batch ON lbank_futures_poll (batch_id)`);
    await q.query(
      `CREATE INDEX ix_lbank_futures_poll_started ON lbank_futures_poll (request_started_at)`,
    );

    await q.query(`ALTER TABLE lbank_futures_sample ADD poll_id bigint`);
    await q.query(`ALTER TABLE lbank_futures_sample ADD stored_at timestamptz`);
    await q.query(
      `ALTER TABLE lbank_futures_sample ALTER COLUMN stored_at SET DEFAULT clock_timestamp()`,
    );
    await q.query(`CREATE INDEX ix_lbank_futures_sample_poll ON lbank_futures_sample (poll_id)`);
    await q.query(
      `ALTER TABLE lbank_futures_sample ADD CONSTRAINT lbank_futures_sample_poll_id_fkey FOREIGN KEY (poll_id) REFERENCES lbank_futures_poll(id) ON DELETE RESTRICT`,
    );

    await q.query(`ALTER TABLE lbank_futures_observation ADD highest_observed_at timestamptz`);
    await q.query(`ALTER TABLE lbank_futures_observation ADD lowest_observed_at timestamptz`);

    await q.query(`CREATE TABLE lbank_futures_reference (
  id                     BIGSERIAL NOT NULL,
  futures_observation_id uuid NOT NULL,
  kind                   lbank_fut_reference_kind NOT NULL,
  rules_version          text NOT NULL,
  contract               text NOT NULL,
  actionable_start       timestamptz NOT NULL,
  poll_id                bigint NOT NULL,
  source                 lbank_fut_request_trigger NOT NULL,
  endpoint               text NOT NULL,
  request_queued_at      timestamptz,
  request_started_at     timestamptz NOT NULL,
  response_received_at   timestamptz NOT NULL,
  stored_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_price             numeric NOT NULL,
  quote_refreshed_at     timestamptz,
  turnover_24h           numeric,
  volume_24h             numeric,
  failed_attempts_before integer NOT NULL DEFAULT '0',
  CONSTRAINT lbank_futures_reference_pkey PRIMARY KEY (id),
  CONSTRAINT ux_lbank_futures_reference_kind UNIQUE (futures_observation_id, kind),
  CONSTRAINT lbank_futures_reference_price_positive CHECK (last_price > 0),
  CONSTRAINT lbank_futures_reference_received_after_sent CHECK (response_received_at >= request_started_at),
  CONSTRAINT lbank_futures_reference_sent_after_start CHECK (request_started_at >= actionable_start),
  CONSTRAINT lbank_futures_reference_futures_observation_id_fkey FOREIGN KEY (futures_observation_id) REFERENCES lbank_futures_observation(id) ON DELETE RESTRICT,
  CONSTRAINT lbank_futures_reference_poll_id_fkey FOREIGN KEY (poll_id) REFERENCES lbank_futures_poll(id) ON DELETE RESTRICT
)`);
    // The earliest receipt wins: a row may only move to an earlier response of the same observation
    // and kind; it is never deleted.
    await q.query(`CREATE FUNCTION lbank_futures_reference_earliest() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lbank_futures_reference %: rows are never deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.futures_observation_id IS DISTINCT FROM OLD.futures_observation_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.actionable_start IS DISTINCT FROM OLD.actionable_start
     OR NOT (NEW.response_received_at < OLD.response_received_at
             OR (NEW.response_received_at = OLD.response_received_at AND NEW.request_started_at < OLD.request_started_at)) THEN
    RAISE EXCEPTION 'lbank_futures_reference %: only an earlier response can replace the reference', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_futures_reference_earliest BEFORE UPDATE OR DELETE ON lbank_futures_reference FOR EACH ROW EXECUTE FUNCTION lbank_futures_reference_earliest()`,
    );

    await q.query(`CREATE TABLE lbank_futures_book (
  id                     BIGSERIAL NOT NULL,
  futures_observation_id uuid NOT NULL,
  contract               text NOT NULL,
  endpoint               text NOT NULL,
  request_started_at     timestamptz,
  response_received_at   timestamptz NOT NULL,
  stored_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  ok                     boolean NOT NULL,
  error                  text,
  best_bid               numeric,
  best_ask               numeric,
  bids                   jsonb,
  asks                   jsonb,
  response_sha256        text,
  CONSTRAINT lbank_futures_book_pkey PRIMARY KEY (id),
  CONSTRAINT lbank_futures_book_futures_observation_id_fkey FOREIGN KEY (futures_observation_id) REFERENCES lbank_futures_observation(id) ON DELETE RESTRICT
)`);
    await q.query(
      `CREATE INDEX ix_lbank_futures_book_obs ON lbank_futures_book (futures_observation_id)`,
    );
    await q.query(
      `CREATE TRIGGER lbank_futures_book_immutable BEFORE UPDATE OR DELETE ON lbank_futures_book FOR EACH ROW EXECUTE FUNCTION lbank_futures_immutable()`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE lbank_futures_book`);
    await q.query(`DROP TABLE lbank_futures_reference`);
    await q.query(`DROP FUNCTION lbank_futures_reference_earliest()`);
    await q.query(`ALTER TABLE lbank_futures_observation DROP COLUMN lowest_observed_at`);
    await q.query(`ALTER TABLE lbank_futures_observation DROP COLUMN highest_observed_at`);
    await q.query(
      `ALTER TABLE lbank_futures_sample DROP CONSTRAINT lbank_futures_sample_poll_id_fkey`,
    );
    await q.query(`DROP INDEX ix_lbank_futures_sample_poll`);
    await q.query(`ALTER TABLE lbank_futures_sample DROP COLUMN stored_at`);
    await q.query(`ALTER TABLE lbank_futures_sample DROP COLUMN poll_id`);
    await q.query(`DROP INDEX ix_lbank_futures_poll_started`);
    await q.query(`DROP INDEX ix_lbank_futures_poll_batch`);
    for (const c of [
      'stored_at',
      'body_gzip',
      'batch_id',
      'endpoint',
      'request_started_at',
      'request_queued_at',
      'attempt',
      'trigger',
    ])
      await q.query(`ALTER TABLE lbank_futures_poll DROP COLUMN ${c}`);
    await q.query(`DROP TYPE lbank_fut_reference_kind`);
    await q.query(`DROP TYPE lbank_fut_request_trigger`);
  }
}

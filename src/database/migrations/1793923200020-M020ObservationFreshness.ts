import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M020: observation freshness and the indicative Spot quote at publication (docs/lbank-spot-observation.md
 * § 13b, ADR-0013). Adds, never rewrites: no existing row, price, time or rules version is changed.
 *  - `lbank_futures_observation.values_changed_at`: set by a trigger when a displayed Futures value
 *    (status, mapping, contract, reasons, flags, reference, extremes, coverage, data-through,
 *    finalization) actually changes; a write that changes nothing (every minute's re-evaluation)
 *    keeps it. NULL on existing rows until their next change. The dashboard's change token reads it.
 *  - `lbank_spot_price_request`: the Spot price request fired with the Futures quote when a Review
 *    Queue is published (every pair in one request): queue, send and receive times, failed attempts,
 *    LBank's response time and the raw body. Immutable.
 *  - `lbank_spot_indicative_quote`: one indicative Spot quote per observation, taken from that request.
 *    Context only: never the Spot reference (the first verified trade) and never a Spot return input.
 *    Immutable.
 */
export class M020ObservationFreshness1793923200020 implements MigrationInterface {
  name = 'M020ObservationFreshness1793923200020';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE lbank_futures_observation ADD values_changed_at timestamptz`);
    await q.query(
      `CREATE INDEX ix_lbank_futures_observation_changed ON lbank_futures_observation (values_changed_at)`,
    );
    // Runs after lbank_futures_observation_frozen (same timing; triggers fire in name order), so a
    // finalized row still rejects any value change before this stamps it.
    await q.query(`CREATE FUNCTION lbank_futures_observation_values_changed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.values_changed_at := clock_timestamp();
  ELSIF (NEW.status, NEW.mapping_status, NEW.contract, NEW.reasons, NEW.flags,
         NEW.reference_price, NEW.reference_after, NEW.reference_before,
         NEW.highest_price, NEW.highest_after, NEW.highest_before, NEW.highest_observed_at, NEW.highest_return_pct,
         NEW.lowest_price, NEW.lowest_after, NEW.lowest_before, NEW.lowest_observed_at, NEW.lowest_return_pct,
         NEW.samples_in_window, NEW.bracketed_in_window, NEW.max_gap_ms, NEW.sampled_through, NEW.finalized_at)
        IS DISTINCT FROM
        (OLD.status, OLD.mapping_status, OLD.contract, OLD.reasons, OLD.flags,
         OLD.reference_price, OLD.reference_after, OLD.reference_before,
         OLD.highest_price, OLD.highest_after, OLD.highest_before, OLD.highest_observed_at, OLD.highest_return_pct,
         OLD.lowest_price, OLD.lowest_after, OLD.lowest_before, OLD.lowest_observed_at, OLD.lowest_return_pct,
         OLD.samples_in_window, OLD.bracketed_in_window, OLD.max_gap_ms, OLD.sampled_through, OLD.finalized_at) THEN
    NEW.values_changed_at := clock_timestamp();
  ELSE
    NEW.values_changed_at := OLD.values_changed_at;
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_futures_observation_values_changed BEFORE INSERT OR UPDATE ON lbank_futures_observation FOR EACH ROW EXECUTE FUNCTION lbank_futures_observation_values_changed()`,
    );

    await q.query(`CREATE TABLE lbank_spot_price_request (
  id                   BIGSERIAL NOT NULL,
  batch_id             uuid NOT NULL,
  endpoint             text NOT NULL,
  request_queued_at    timestamptz NOT NULL,
  request_started_at   timestamptz,
  response_received_at timestamptz NOT NULL,
  stored_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  ok                   boolean NOT NULL,
  error                text,
  failed_attempts      jsonb NOT NULL DEFAULT '[]',
  lbank_server_at      timestamptz,
  pairs                integer NOT NULL DEFAULT '0',
  invalid              integer NOT NULL DEFAULT '0',
  response_sha256      text,
  body_gzip            bytea,
  CONSTRAINT lbank_spot_price_request_pkey PRIMARY KEY (id)
)`);
    await q.query(
      `CREATE INDEX ix_lbank_spot_price_request_batch ON lbank_spot_price_request (batch_id)`,
    );

    await q.query(`CREATE TABLE lbank_spot_indicative_quote (
  id                   BIGSERIAL NOT NULL,
  observation_id       uuid NOT NULL,
  request_id           bigint NOT NULL,
  pair_symbol          text NOT NULL,
  actionable_start     timestamptz NOT NULL,
  price                numeric NOT NULL,
  request_queued_at    timestamptz NOT NULL,
  request_started_at   timestamptz NOT NULL,
  response_received_at timestamptz NOT NULL,
  lbank_server_at      timestamptz,
  stored_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lbank_spot_indicative_quote_pkey PRIMARY KEY (id),
  CONSTRAINT ux_lbank_spot_indicative_quote_observation UNIQUE (observation_id),
  CONSTRAINT lbank_spot_indicative_quote_price_positive CHECK (price > 0),
  CONSTRAINT lbank_spot_indicative_quote_sent_after_start CHECK (request_started_at >= actionable_start),
  CONSTRAINT lbank_spot_indicative_quote_received_after_sent CHECK (response_received_at >= request_started_at),
  CONSTRAINT lbank_spot_indicative_quote_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES lbank_observation(id) ON DELETE RESTRICT,
  CONSTRAINT lbank_spot_indicative_quote_request_id_fkey FOREIGN KEY (request_id) REFERENCES lbank_spot_price_request(id) ON DELETE RESTRICT
)`);
    for (const t of ['lbank_spot_price_request', 'lbank_spot_indicative_quote'])
      await q.query(
        `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION lbank_futures_immutable()`,
      );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE lbank_spot_indicative_quote`);
    await q.query(`DROP TABLE lbank_spot_price_request`);
    await q.query(
      `DROP TRIGGER lbank_futures_observation_values_changed ON lbank_futures_observation`,
    );
    await q.query(`DROP FUNCTION lbank_futures_observation_values_changed()`);
    await q.query(`DROP INDEX ix_lbank_futures_observation_changed`);
    await q.query(`ALTER TABLE lbank_futures_observation DROP COLUMN values_changed_at`);
  }
}

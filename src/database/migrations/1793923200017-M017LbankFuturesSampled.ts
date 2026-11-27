import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M017: LBank Futures sampled observation (rules `lbank-futures-sampled-1`,
 * docs/lbank-spot-observation.md § 13, ADR-0011). Adds, never rewrites: the Spot observation, its
 * results and its rules stay exactly as they are.
 *  - `lbank_futures_sample`: contracts' `marketData` snapshots (only contracts an open observation
 *    needs), immutable;
 *  - `lbank_futures_poll`: every read of `marketData` (sampling continuity and gaps), append-only;
 *  - `lbank_futures_observation`: one per Spot observation (same event, same start), its own contract,
 *    mapping, sampled reference, bounds, coverage, status and rules version; frozen once finalized.
 * Enum values mirror `futures-rules.ts`.
 */
export class M017LbankFuturesSampled1793923200017 implements MigrationInterface {
  name = 'M017LbankFuturesSampled1793923200017';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TYPE lbank_fut_mapping_status AS ENUM ('PENDING', 'OK', 'AMBIGUOUS', 'NONE', 'UNKNOWN')`,
    );
    await q.query(
      `CREATE TYPE lbank_fut_status AS ENUM ('PENDING', 'ACTIVE', 'CLOSED', 'NO_REFERENCE', 'HISTORY_UNAVAILABLE', 'NO_CONTRACT', 'MAPPING_AMBIGUOUS', 'MAPPING_UNKNOWN')`,
    );
    await q.query(`CREATE TABLE lbank_futures_observation (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  observation_id      uuid NOT NULL,
  provider_id         text NOT NULL,
  rules_version       text NOT NULL,
  mapping_status      lbank_fut_mapping_status NOT NULL,
  contract            text,
  mapping_evidence    jsonb NOT NULL DEFAULT '{}',
  status              lbank_fut_status NOT NULL,
  reasons             text[] NOT NULL DEFAULT '{}',
  flags               text[] NOT NULL DEFAULT '{}',
  fold                jsonb NOT NULL DEFAULT '{}',
  reference_price     numeric,
  reference_after     timestamptz,
  reference_before    timestamptz,
  highest_price       numeric,
  highest_after       timestamptz,
  highest_before      timestamptz,
  highest_return_pct  numeric(65,30),
  lowest_price        numeric,
  lowest_after        timestamptz,
  lowest_before       timestamptz,
  lowest_return_pct   numeric(65,30),
  samples_in_window   integer NOT NULL DEFAULT '0',
  bracketed_in_window integer NOT NULL DEFAULT '0',
  max_gap_ms          bigint NOT NULL DEFAULT '0',
  sampled_through     timestamptz,
  last_update_at      timestamptz,
  finalized_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lbank_futures_observation_pkey PRIMARY KEY (id),
  CONSTRAINT ux_lbank_futures_observation_obs UNIQUE (observation_id),
  CONSTRAINT lbank_futures_observation_returns_signed CHECK ((highest_return_pct IS NULL OR highest_return_pct >= 0) AND (lowest_return_pct IS NULL OR lowest_return_pct <= 0)),
  CONSTRAINT lbank_futures_observation_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES lbank_observation(id) ON DELETE RESTRICT,
  CONSTRAINT lbank_futures_observation_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider(id) ON DELETE RESTRICT
)`);
    await q.query(
      `CREATE INDEX ix_lbank_futures_observation_status ON lbank_futures_observation (provider_id, status)`,
    );
    // A finalized Futures observation never changes again (only updated_at may move).
    await q.query(`CREATE FUNCTION lbank_futures_observation_frozen() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'lbank_futures_observation %: a finalized observation is frozen', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_futures_observation_frozen BEFORE UPDATE ON lbank_futures_observation FOR EACH ROW EXECUTE FUNCTION lbank_futures_observation_frozen()`,
    );

    await q.query(`CREATE TABLE lbank_futures_poll (
  id              BIGSERIAL NOT NULL,
  fetched_at      timestamptz NOT NULL,
  server_at       timestamptz,
  ok              boolean NOT NULL,
  contracts       integer NOT NULL DEFAULT '0',
  stored          integer NOT NULL DEFAULT '0',
  invalid         integer NOT NULL DEFAULT '0',
  error           text,
  response_sha256 text,
  CONSTRAINT lbank_futures_poll_pkey PRIMARY KEY (id)
)`);
    await q.query(`CREATE INDEX ix_lbank_futures_poll_fetched ON lbank_futures_poll (fetched_at)`);

    await q.query(`CREATE TABLE lbank_futures_sample (
  contract          text NOT NULL,
  server_at         timestamptz NOT NULL,
  fetched_at        timestamptz NOT NULL,
  last_price        numeric NOT NULL,
  turnover_24h      numeric NOT NULL,
  volume_24h        numeric NOT NULL,
  high_24h          numeric,
  low_24h           numeric,
  mark_price        numeric,
  instrument_status text,
  response_sha256   text NOT NULL,
  CONSTRAINT lbank_futures_sample_pkey PRIMARY KEY (contract, server_at)
)`);
    await q.query(`CREATE FUNCTION lbank_futures_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: rows are immutable evidence', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END
$$`);
    for (const t of ['lbank_futures_sample', 'lbank_futures_poll'])
      await q.query(
        `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION lbank_futures_immutable()`,
      );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE lbank_futures_sample`);
    await q.query(`DROP TABLE lbank_futures_poll`);
    await q.query(`DROP FUNCTION lbank_futures_immutable()`);
    await q.query(`DROP TABLE lbank_futures_observation`);
    await q.query(`DROP FUNCTION lbank_futures_observation_frozen()`);
    await q.query(`DROP TYPE lbank_fut_status`);
    await q.query(`DROP TYPE lbank_fut_mapping_status`);
  }
}

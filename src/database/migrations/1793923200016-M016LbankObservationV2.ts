import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M016: LBank Spot Price Observation rules v2 (`lbank-spot-obs-2`, docs/lbank-spot-observation.md,
 * ADR-0009 addendum 2026-11-25). Adds, never rewrites:
 *  - the actionable observation start and its provenance (`actionable_*`, `observation_start/end`):
 *    the event key, its UTC date, the cutover routing and the event snapshot stay crawl-based;
 *  - the reference trade, the trade-verified extremes, review flags, gap states and data freshness on
 *    `lbank_observation` (the v1 candle columns stay as an audit record) and on its results;
 *  - shared trade evidence per pair (`lbank_spot_trade`, `lbank_spot_trade_minute`), a compressed
 *    per-day candle archive (`lbank_spot_candle_archive`) and the audit log of rules changes
 *    (`lbank_obs_rules_change`);
 *  - statuses NO_TRADES and UNVERIFIABLE.
 * The freeze trigger is replaced: v1 values never change once a row leaves rules v1, every rules
 * change needs its log row, and a finalized row reopens only for a newer rules version so logged
 * (its result rows stay: append-only). Enum values mirror `observation.constants.ts`.
 */
const V1_AUDIT_COLUMNS = [
  'window_end',
  'entry_at',
  'entry_price',
  'entry_delay_ms',
  'entry_last_trade_at',
  'entry_stale',
  'high_price',
  'high_bar_at',
  'low_price',
  'low_bar_at',
  'max_rise_pct',
  'max_drop_pct',
  'low_before_high_price',
  'low_before_high_bar_at',
  'extreme_order',
  'expected_bars',
  'observed_through',
  'covered_bars',
  'traded_bars',
  'missing_bars',
  'missing_ranges',
  'start_unobserved_ms',
  'boundary_unobserved_ms',
  'series_sha256',
];
/** Columns of a finalized lbank_observation that may still change (provenance links, timestamp). */
const OBSERVATION_FROZEN_EXCEPT = ['spot_list_fetch_id', 'futures_list_fetch_id', 'updated_at'];
const arr = (cols: string[]) => `ARRAY[${cols.map((c) => `'${c}'`).join(', ')}]::text[]`;

export class M016LbankObservationV21793923200016 implements MigrationInterface {
  name = 'M016LbankObservationV21793923200016';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TYPE lbank_obs_status ADD VALUE IF NOT EXISTS 'NO_TRADES'`);
    await q.query(`ALTER TYPE lbank_obs_status ADD VALUE IF NOT EXISTS 'UNVERIFIABLE'`);
    await q.query(
      `CREATE TYPE lbank_obs_timing_source AS ENUM ('SCAN_COMMIT', 'EVENT_COMMIT', 'JOB_FIRST_SEEN')`,
    );
    await q.query(
      `CREATE TYPE lbank_obs_reference_status AS ENUM ('PENDING', 'VERIFIED', 'NO_TRADE', 'UNVERIFIED')`,
    );
    await q.query(
      `CREATE TYPE lbank_obs_extremes_order AS ENUM ('HIGH_FIRST', 'LOW_FIRST', 'SAME_MS')`,
    );
    await q.query(
      `CREATE TYPE lbank_trade_check_status AS ENUM ('VERIFIED', 'TRADES_BELOW_CANDLE', 'PAGING_INCOMPLETE', 'FETCH_FAILED', 'PAIR_UNSUPPORTED')`,
    );

    // ── Pair freshness (attempts and successes kept apart) ──────────────────────────────────
    await q.query(`ALTER TABLE lbank_spot_pair
  ADD COLUMN last_success_at        timestamptz,
  ADD COLUMN trades_last_attempt_at timestamptz,
  ADD COLUMN trades_last_success_at timestamptz,
  ADD COLUMN trades_last_error      text`);

    // ── Observation: rules v2 (v1-only columns stay as audit; empty on v2 rows) ─────────────
    await q.query(`ALTER TABLE lbank_observation
  ALTER COLUMN expected_bars DROP NOT NULL,
  ALTER COLUMN covered_bars DROP NOT NULL,
  ALTER COLUMN covered_bars DROP DEFAULT,
  ALTER COLUMN traded_bars DROP NOT NULL,
  ALTER COLUMN traded_bars DROP DEFAULT,
  ALTER COLUMN missing_bars DROP NOT NULL,
  ALTER COLUMN missing_bars DROP DEFAULT,
  ALTER COLUMN missing_ranges DROP NOT NULL,
  ALTER COLUMN start_unobserved_ms DROP NOT NULL,
  ALTER COLUMN boundary_unobserved_ms DROP NOT NULL,
  ADD COLUMN actionable_at               timestamptz,
  ADD COLUMN actionable_source           lbank_obs_timing_source,
  ADD COLUMN actionable_evidence         jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN observation_start           timestamptz,
  ADD COLUMN observation_end             timestamptz,
  ADD COLUMN reference_status            lbank_obs_reference_status NOT NULL DEFAULT 'PENDING',
  ADD COLUMN reference_trade_id          text,
  ADD COLUMN reference_at                timestamptz,
  ADD COLUMN reference_price             numeric,
  ADD COLUMN reference_qty               numeric,
  ADD COLUMN reference_delay_ms          integer,
  ADD COLUMN reference_delayed           boolean,
  ADD COLUMN reference_evidence          jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN highest_price               numeric,
  ADD COLUMN highest_at                  timestamptz,
  ADD COLUMN highest_trade_id            text,
  ADD COLUMN highest_return_pct          numeric(65,30),
  ADD COLUMN lowest_price                numeric,
  ADD COLUMN lowest_at                   timestamptz,
  ADD COLUMN lowest_trade_id             text,
  ADD COLUMN lowest_return_pct           numeric(65,30),
  ADD COLUMN low_before_highest_price    numeric,
  ADD COLUMN low_before_highest_at       timestamptz,
  ADD COLUMN low_before_highest_trade_id text,
  ADD COLUMN extremes_order              lbank_obs_extremes_order,
  ADD COLUMN extremes_proven             boolean NOT NULL DEFAULT false,
  ADD COLUMN extremes_evidence           jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN flags                       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN flags_evidence              jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN minutes_expected            integer,
  ADD COLUMN minutes_present             integer NOT NULL DEFAULT 0,
  ADD COLUMN minutes_traded              integer NOT NULL DEFAULT 0,
  ADD COLUMN minutes_missing             integer NOT NULL DEFAULT 0,
  ADD COLUMN gaps                        jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN data_through                timestamptz,
  ADD COLUMN last_source_fetch_at        timestamptz,
  ADD COLUMN last_fetch_attempt_at       timestamptz,
  ADD COLUMN last_fetch_error            text,
  ADD COLUMN retry_until                 timestamptz,
  ADD COLUMN evidence_sha256             text,
  ADD CONSTRAINT lbank_observation_window_exact CHECK (observation_start IS NULL OR observation_end = observation_start + interval '168 hours'),
  ADD CONSTRAINT lbank_observation_start_after_crawl CHECK (observation_start IS NULL OR observation_start >= t0),
  ADD CONSTRAINT lbank_observation_returns_signed CHECK ((highest_return_pct IS NULL OR highest_return_pct >= 0) AND (lowest_return_pct IS NULL OR lowest_return_pct <= 0))`);
    await q.query(
      `CREATE INDEX ix_lbank_observation_start ON lbank_observation (provider_id, observation_start)`,
    );

    await q.query(`ALTER TABLE lbank_observation_result
  ALTER COLUMN expected_bars DROP NOT NULL,
  ALTER COLUMN covered_bars DROP NOT NULL,
  ALTER COLUMN traded_bars DROP NOT NULL,
  ALTER COLUMN missing_bars DROP NOT NULL,
  ALTER COLUMN missing_ranges DROP NOT NULL,
  ADD COLUMN actionable_at            timestamptz,
  ADD COLUMN actionable_source        lbank_obs_timing_source,
  ADD COLUMN observation_start        timestamptz,
  ADD COLUMN observation_end          timestamptz,
  ADD COLUMN reference_status         lbank_obs_reference_status,
  ADD COLUMN reference_trade_id       text,
  ADD COLUMN reference_at             timestamptz,
  ADD COLUMN reference_price          numeric,
  ADD COLUMN reference_delay_ms       integer,
  ADD COLUMN highest_price            numeric,
  ADD COLUMN highest_at               timestamptz,
  ADD COLUMN highest_trade_id         text,
  ADD COLUMN highest_return_pct       numeric(65,30),
  ADD COLUMN lowest_price             numeric,
  ADD COLUMN lowest_at                timestamptz,
  ADD COLUMN lowest_trade_id          text,
  ADD COLUMN lowest_return_pct        numeric(65,30),
  ADD COLUMN low_before_highest_price numeric,
  ADD COLUMN low_before_highest_at    timestamptz,
  ADD COLUMN extremes_order           lbank_obs_extremes_order,
  ADD COLUMN flags                    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN gaps                     jsonb,
  ADD COLUMN minutes_expected         integer,
  ADD COLUMN minutes_present          integer,
  ADD COLUMN minutes_traded           integer,
  ADD COLUMN minutes_missing          integer,
  ADD COLUMN evidence_sha256          text,
  ADD COLUMN detail                   jsonb`);

    // ── Trade evidence, shared per pair ─────────────────────────────────────────────────────
    await q.query(`CREATE TABLE lbank_spot_trade (
  pair_id        integer NOT NULL,
  trade_id       text NOT NULL,
  traded_at      timestamptz NOT NULL,
  ms_ord         integer NOT NULL,
  price          numeric NOT NULL,
  qty            numeric NOT NULL,
  is_buyer_maker boolean,
  fetched_at     timestamptz NOT NULL,
  CONSTRAINT lbank_spot_trade_pkey PRIMARY KEY (pair_id, trade_id),
  CONSTRAINT lbank_spot_trade_values CHECK (price > 0 AND qty > 0 AND ms_ord >= 0),
  CONSTRAINT lbank_spot_trade_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES lbank_spot_pair (id) ON DELETE RESTRICT
)`);
    await q.query(
      `CREATE INDEX ix_lbank_spot_trade_time ON lbank_spot_trade (pair_id, traded_at, ms_ord)`,
    );
    await q.query(`CREATE FUNCTION lbank_spot_trade_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lbank_spot_trade (pair %, %): a stored trade is immutable', OLD.pair_id, OLD.trade_id
    USING ERRCODE = 'check_violation';
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_spot_trade_immutable BEFORE UPDATE ON lbank_spot_trade FOR EACH ROW EXECUTE FUNCTION lbank_spot_trade_immutable()`,
    );

    await q.query(`CREATE TABLE lbank_spot_trade_minute (
  pair_id          integer NOT NULL,
  minute_at        timestamptz NOT NULL,
  status           lbank_trade_check_status NOT NULL,
  trade_count      integer,
  qty_sum          numeric,
  candle_volume    numeric,
  candle_surplus   numeric,
  pages            integer NOT NULL,
  attempts         integer NOT NULL DEFAULT 1,
  responses_sha256 text[] NOT NULL DEFAULT '{}',
  error            text,
  first_checked_at timestamptz NOT NULL,
  checked_at       timestamptz NOT NULL,
  CONSTRAINT lbank_spot_trade_minute_pkey PRIMARY KEY (pair_id, minute_at),
  CONSTRAINT lbank_spot_trade_minute_whole CHECK (mod(extract(epoch FROM minute_at), 60) = 0),
  CONSTRAINT lbank_spot_trade_minute_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES lbank_spot_pair (id) ON DELETE RESTRICT
)`);
    await q.query(`CREATE FUNCTION lbank_spot_trade_minute_verified() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'VERIFIED' THEN
    RAISE EXCEPTION 'lbank_spot_trade_minute (pair %, %): a verified minute is immutable', OLD.pair_id, OLD.minute_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_spot_trade_minute_verified BEFORE UPDATE ON lbank_spot_trade_minute FOR EACH ROW EXECUTE FUNCTION lbank_spot_trade_minute_verified()`,
    );

    // ── Candle archive: one compressed CSV per pair and UTC day, before raw rows are pruned ─────
    await q.query(`CREATE TABLE lbank_spot_candle_archive (
  pair_id        integer NOT NULL,
  utc_date       date NOT NULL,
  first_minute   timestamptz NOT NULL,
  last_minute    timestamptz NOT NULL,
  bars           integer NOT NULL,
  traded_bars    integer NOT NULL,
  encoding       text NOT NULL,
  content        bytea NOT NULL,
  content_sha256 text NOT NULL,
  raw_bytes      integer NOT NULL,
  archived_at    timestamptz NOT NULL,
  CONSTRAINT lbank_spot_candle_archive_pkey PRIMARY KEY (pair_id, utc_date),
  CONSTRAINT lbank_spot_candle_archive_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES lbank_spot_pair (id) ON DELETE RESTRICT
)`);
    await q.query(`CREATE FUNCTION lbank_spot_candle_archive_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lbank_spot_candle_archive (pair %, %): an archive is immutable', OLD.pair_id, OLD.utc_date
    USING ERRCODE = 'check_violation';
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_spot_candle_archive_immutable BEFORE UPDATE OR DELETE ON lbank_spot_candle_archive FOR EACH ROW EXECUTE FUNCTION lbank_spot_candle_archive_immutable()`,
    );

    // ── Rules changes: the audit trail of every recalculation under a new rules version ───────
    await q.query(`CREATE TABLE lbank_obs_rules_change (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  observation_id      uuid NOT NULL,
  from_rules_version  text NOT NULL,
  to_rules_version    text NOT NULL,
  from_status         lbank_obs_status NOT NULL,
  from_result_version integer NOT NULL,
  from_finalized_at   timestamptz,
  previous            jsonb NOT NULL,
  reason              text NOT NULL,
  changed_at          timestamptz NOT NULL,
  CONSTRAINT lbank_obs_rules_change_pkey PRIMARY KEY (id),
  CONSTRAINT ux_lbank_obs_rules_change UNIQUE (observation_id, from_rules_version, to_rules_version),
  CONSTRAINT lbank_obs_rules_change_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES lbank_observation (id) ON DELETE RESTRICT
)`);
    await q.query(`CREATE FUNCTION lbank_obs_rules_change_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lbank_obs_rules_change %: the audit trail is append-only', OLD.id
    USING ERRCODE = 'check_violation';
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_obs_rules_change_append_only BEFORE UPDATE OR DELETE ON lbank_obs_rules_change FOR EACH ROW EXECUTE FUNCTION lbank_obs_rules_change_append_only()`,
    );

    // ── Freeze rules (replaces M015's function; the trigger keeps calling it) ─────────────────
    await q.query(`CREATE OR REPLACE FUNCTION lbank_observation_frozen() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v1 text[] := ${arr(V1_AUDIT_COLUMNS)};
  n jsonb := to_jsonb(NEW);
  o jsonb := to_jsonb(OLD);
BEGIN
  IF NEW.rules_version <> OLD.rules_version AND NOT EXISTS (
       SELECT 1 FROM lbank_obs_rules_change c
        WHERE c.observation_id = OLD.id AND c.from_rules_version = OLD.rules_version
          AND c.to_rules_version = NEW.rules_version AND c.from_result_version = OLD.result_version) THEN
    RAISE EXCEPTION 'lbank_observation %: a rules change needs its lbank_obs_rules_change row', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- The rules-v1 values (candle-OPEN entry from the crawl time) are an audit record once the row
  -- leaves rules v1.
  IF (OLD.rules_version <> 'lbank-spot-obs-1' OR NEW.rules_version <> OLD.rules_version)
     AND (SELECT jsonb_object_agg(k, v) FROM jsonb_each(n) AS e(k, v) WHERE k = ANY (v1))
         IS DISTINCT FROM (SELECT jsonb_object_agg(k, v) FROM jsonb_each(o) AS e(k, v) WHERE k = ANY (v1)) THEN
    RAISE EXCEPTION 'lbank_observation %: the rules-v1 values are an audit record and never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.finalized_at IS NOT NULL THEN
    -- Reopened only for a newer rules version recorded above; the frozen result rows stay.
    IF NEW.finalized_at IS NULL AND NEW.rules_version <> OLD.rules_version THEN
      RETURN NEW;
    END IF;
    IF (n - ${arr(OBSERVATION_FROZEN_EXCEPT)}) IS DISTINCT FROM (o - ${arr(OBSERVATION_FROZEN_EXCEPT)}) THEN
      RAISE EXCEPTION 'lbank_observation %: a finalized observation is frozen', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // M015's freeze function (enum values added above cannot be removed; they stay unused).
    await q.query(`CREATE OR REPLACE FUNCTION lbank_observation_frozen() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL
     AND (to_jsonb(NEW) - ${arr(OBSERVATION_FROZEN_EXCEPT)}) IS DISTINCT FROM (to_jsonb(OLD) - ${arr(OBSERVATION_FROZEN_EXCEPT)}) THEN
    RAISE EXCEPTION 'lbank_observation %: a finalized observation is frozen', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    for (const table of [
      'lbank_obs_rules_change',
      'lbank_spot_candle_archive',
      'lbank_spot_trade_minute',
      'lbank_spot_trade',
    ])
      await q.query(`DROP TABLE ${table}`);
    for (const fn of [
      'lbank_obs_rules_change_append_only',
      'lbank_spot_candle_archive_immutable',
      'lbank_spot_trade_minute_verified',
      'lbank_spot_trade_immutable',
    ])
      await q.query(`DROP FUNCTION ${fn}()`);
    await q.query(`ALTER TABLE lbank_observation_result
  DROP COLUMN actionable_at, DROP COLUMN actionable_source, DROP COLUMN observation_start,
  DROP COLUMN observation_end, DROP COLUMN reference_status, DROP COLUMN reference_trade_id,
  DROP COLUMN reference_at, DROP COLUMN reference_price, DROP COLUMN reference_delay_ms,
  DROP COLUMN highest_price, DROP COLUMN highest_at, DROP COLUMN highest_trade_id,
  DROP COLUMN highest_return_pct, DROP COLUMN lowest_price, DROP COLUMN lowest_at,
  DROP COLUMN lowest_trade_id, DROP COLUMN lowest_return_pct, DROP COLUMN low_before_highest_price,
  DROP COLUMN low_before_highest_at, DROP COLUMN extremes_order, DROP COLUMN flags, DROP COLUMN gaps,
  DROP COLUMN minutes_expected, DROP COLUMN minutes_present, DROP COLUMN minutes_traded,
  DROP COLUMN minutes_missing, DROP COLUMN evidence_sha256, DROP COLUMN detail`);
    await q.query(`DROP INDEX ix_lbank_observation_start`);
    await q.query(`ALTER TABLE lbank_observation
  DROP CONSTRAINT lbank_observation_window_exact, DROP CONSTRAINT lbank_observation_start_after_crawl,
  DROP CONSTRAINT lbank_observation_returns_signed,
  DROP COLUMN actionable_at, DROP COLUMN actionable_source, DROP COLUMN actionable_evidence,
  DROP COLUMN observation_start, DROP COLUMN observation_end, DROP COLUMN reference_status,
  DROP COLUMN reference_trade_id, DROP COLUMN reference_at, DROP COLUMN reference_price,
  DROP COLUMN reference_qty, DROP COLUMN reference_delay_ms, DROP COLUMN reference_delayed,
  DROP COLUMN reference_evidence, DROP COLUMN highest_price, DROP COLUMN highest_at,
  DROP COLUMN highest_trade_id, DROP COLUMN highest_return_pct, DROP COLUMN lowest_price,
  DROP COLUMN lowest_at, DROP COLUMN lowest_trade_id, DROP COLUMN lowest_return_pct,
  DROP COLUMN low_before_highest_price, DROP COLUMN low_before_highest_at,
  DROP COLUMN low_before_highest_trade_id, DROP COLUMN extremes_order, DROP COLUMN extremes_proven,
  DROP COLUMN extremes_evidence, DROP COLUMN flags, DROP COLUMN flags_evidence,
  DROP COLUMN minutes_expected, DROP COLUMN minutes_present, DROP COLUMN minutes_traded,
  DROP COLUMN minutes_missing, DROP COLUMN gaps, DROP COLUMN data_through,
  DROP COLUMN last_source_fetch_at, DROP COLUMN last_fetch_attempt_at, DROP COLUMN last_fetch_error,
  DROP COLUMN retry_until, DROP COLUMN evidence_sha256`);
    await q.query(`ALTER TABLE lbank_spot_pair
  DROP COLUMN last_success_at, DROP COLUMN trades_last_attempt_at,
  DROP COLUMN trades_last_success_at, DROP COLUMN trades_last_error`);
    for (const t of [
      'lbank_trade_check_status',
      'lbank_obs_extremes_order',
      'lbank_obs_reference_status',
      'lbank_obs_timing_source',
    ])
      await q.query(`DROP TYPE ${t}`);
  }
}

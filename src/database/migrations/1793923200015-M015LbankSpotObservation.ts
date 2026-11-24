import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M015: LBank Spot Price Observation and the cutover from the legacy forward test
 * (docs/lbank-spot-observation.md, docs/adr/0009-lbank-spot-observation.md).
 *  - `signal_cutover`: one UTC-midnight cutover per provider; a cutover that has passed never changes.
 *  - The legacy forward test keeps its tables; a trigger closes its intake at the cutover, and
 *    `forward_legacy_closure` records each legacy event's explicit terminal outcome.
 *  - New tables for the new tracker: events at or after the cutover (`lbank_obs_event`, immutable),
 *    intake runs, LBank Spot pairs and their shared 1-minute candles, markets-list fetches,
 *    observations (one per event, unique foreign key), append-only terminal results, job runs.
 * The enum values mirror `modules/lbank-observation/observation.constants.ts` and
 * `modules/forward-test/legacy-closure.ts`.
 */
const ENUMS: ReadonlyArray<readonly [name: string, values: readonly string[]]> = [
  [
    'lbank_obs_status',
    ['ACTIVE', 'FINAL', 'PARTIAL', 'DATA_UNAVAILABLE', 'MAPPING_AMBIGUOUS', 'ELIGIBILITY_UNKNOWN'],
  ],
  [
    'lbank_obs_eligibility',
    [
      'PENDING',
      'SPOT_AND_FUTURES',
      'SPOT_ONLY',
      'SPOT_FUTURES_UNKNOWN',
      'SPOT_UNAVAILABLE',
      'SPOT_UNKNOWN',
      'MAPPING_AMBIGUOUS',
    ],
  ],
  ['lbank_obs_listing_status', ['YES', 'NO', 'UNKNOWN']],
  ['lbank_obs_mapping_status', ['PENDING', 'OK', 'AMBIGUOUS', 'NONE']],
  ['lbank_obs_extreme_order', ['HIGH_FIRST', 'LOW_FIRST', 'SAME_BAR']],
  ['lbank_obs_run_status', ['running', 'succeeded', 'partial', 'failed']],
  ['lbank_market_list_kind', ['spot_pairs', 'futures_instruments']],
  ['forward_legacy_closure_kind', ['FINAL', 'INCOMPLETE', 'DATA_UNAVAILABLE']],
];

/** Columns of lbank_obs_event that ON DELETE SET NULL may clear; everything else is immutable. */
const OBS_EVENT_MUTABLE = ['snapshot_id', 'intake_run_id'];
/** Columns of a finalized lbank_observation that may still change (provenance links, timestamp). */
const OBSERVATION_FROZEN_EXCEPT = ['spot_list_fetch_id', 'futures_list_fetch_id', 'updated_at'];
const arr = (cols: string[]) => `ARRAY[${cols.map((c) => `'${c}'`).join(', ')}]::text[]`;

export class M015LbankSpotObservation1793923200015 implements MigrationInterface {
  name = 'M015LbankSpotObservation1793923200015';

  public async up(q: QueryRunner): Promise<void> {
    for (const [name, values] of ENUMS)
      await q.query(`CREATE TYPE ${name} AS ENUM (${values.map((v) => `'${v}'`).join(', ')})`);

    // ── Cutover ─────────────────────────────────────────────────────────────────────────────
    await q.query(`CREATE TABLE signal_cutover (
  provider_id text NOT NULL,
  cutover_at  timestamptz NOT NULL,
  set_at      timestamptz NOT NULL,
  set_by      text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signal_cutover_pkey PRIMARY KEY (provider_id),
  CONSTRAINT signal_cutover_utc_midnight CHECK (mod(extract(epoch FROM cutover_at), 86400) = 0),
  CONSTRAINT signal_cutover_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await q.query(`CREATE FUNCTION signal_cutover_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cutover_at <= now() THEN
    RAISE EXCEPTION 'signal_cutover %: the cutover % has passed and can no longer change', OLD.provider_id, OLD.cutover_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER signal_cutover_guard BEFORE UPDATE OR DELETE ON signal_cutover FOR EACH ROW EXECUTE FUNCTION signal_cutover_guard()`,
    );

    // The legacy forward test takes no event detected at or after the cutover.
    await q.query(`CREATE FUNCTION forward_event_legacy_intake_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  c timestamptz;
BEGIN
  SELECT cutover_at INTO c FROM signal_cutover WHERE provider_id = NEW.provider_id;
  IF c IS NOT NULL AND NEW.detected_at >= c THEN
    RAISE EXCEPTION 'forward_event: detected % is at or after the cutover %: the legacy forward test takes no new events', NEW.detected_at, c
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER forward_event_legacy_intake_guard BEFORE INSERT ON forward_event FOR EACH ROW EXECUTE FUNCTION forward_event_legacy_intake_guard()`,
    );

    await q.query(`CREATE TABLE forward_legacy_closure (
  event_id          uuid NOT NULL,
  closure           forward_legacy_closure_kind NOT NULL,
  status_at_closure forward_event_status NOT NULL,
  outcome_version   integer NOT NULL,
  peak_kind         forward_peak_kind,
  peak_return_pct   numeric(65,30),
  reasons           text[] NOT NULL DEFAULT '{}',
  closed_at         timestamptz NOT NULL,
  rules_version     text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forward_legacy_closure_pkey PRIMARY KEY (event_id),
  CONSTRAINT forward_legacy_closure_event_id_fkey FOREIGN KEY (event_id) REFERENCES forward_event (id) ON DELETE RESTRICT
)`);

    // ── LBank observation: intake and events ────────────────────────────────────────────────
    await q.query(`CREATE TABLE lbank_obs_intake_run (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id     text NOT NULL,
  batch_id        uuid NOT NULL,
  pipeline_run_id uuid,
  intake_at       timestamptz NOT NULL,
  queue_status    queue_status,
  batch_status    crawl_status NOT NULL,
  queue_rows      integer NOT NULL,
  created         integer NOT NULL,
  ignored         integer NOT NULL,
  rejected        integer NOT NULL,
  details         jsonb NOT NULL,
  notes           text[] NOT NULL DEFAULT '{}',
  CONSTRAINT lbank_obs_intake_run_pkey PRIMARY KEY (id),
  CONSTRAINT lbank_obs_intake_run_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT lbank_obs_intake_run_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE RESTRICT,
  CONSTRAINT lbank_obs_intake_run_pipeline_run_id_fkey FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_run (id) ON DELETE SET NULL
)`);
    await q.query(`CREATE INDEX ix_lbank_obs_intake_run_batch ON lbank_obs_intake_run (batch_id)`);
    await q.query(
      `CREATE INDEX ix_lbank_obs_intake_run_provider ON lbank_obs_intake_run (provider_id, intake_at)`,
    );

    await q.query(`CREATE TABLE lbank_obs_event (
  id                      uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id             text NOT NULL,
  cmc_id                  integer NOT NULL,
  detected_utc_date       date NOT NULL,
  star_count              integer NOT NULL,
  detected_at             timestamptz NOT NULL,
  source_updated_at       timestamptz NOT NULL,
  source_batch_id         uuid NOT NULL,
  slot_time               timestamptz NOT NULL,
  snapshot_id             bigint,
  intake_run_id           uuid,
  is_live                 boolean NOT NULL,
  cmc_price_usd           numeric(38,18) NOT NULL,
  symbol                  text NOT NULL,
  name                    text NOT NULL,
  slug                    text,
  rank                    integer,
  platform_chain          text,
  platform_address        text,
  cap_usd                 numeric(38,8),
  volume_24h_usd          numeric(38,8),
  current_vmc             numeric(65,30),
  vmc_3d_avg              numeric(65,30),
  vmc_7d_avg              numeric(65,30),
  vmc_14d_avg             numeric(65,30),
  vmc_30d_avg             numeric(65,30),
  multiple_3d             numeric(65,30),
  multiple_7d             numeric(65,30),
  multiple_30d            numeric(65,30),
  pass_3d                 pass_status NOT NULL,
  pass_7d                 pass_status NOT NULL,
  pass_30d                pass_status NOT NULL,
  queue_order             integer,
  weighted_pass_points    integer,
  score_complete          boolean,
  weighted_strength       numeric(65,30),
  ranking_ruleset_version text,
  lbank_pairs             jsonb NOT NULL,
  ruleset_version         text NOT NULL,
  config_version          text NOT NULL,
  inputs_hash             text NOT NULL,
  scan_snapshot           jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lbank_obs_event_pkey PRIMARY KEY (id),
  CONSTRAINT ux_lbank_obs_event_key UNIQUE (provider_id, cmc_id, detected_utc_date, star_count),
  CONSTRAINT lbank_obs_event_star_count_range CHECK (star_count BETWEEN 1 AND 3),
  CONSTRAINT lbank_obs_event_cmc_price_positive CHECK (cmc_price_usd > 0),
  CONSTRAINT lbank_obs_event_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT lbank_obs_event_source_batch_id_fkey FOREIGN KEY (source_batch_id) REFERENCES crawl_batch (id) ON DELETE RESTRICT,
  CONSTRAINT lbank_obs_event_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES market_snapshot (id) ON DELETE SET NULL,
  CONSTRAINT lbank_obs_event_intake_run_id_fkey FOREIGN KEY (intake_run_id) REFERENCES lbank_obs_intake_run (id) ON DELETE SET NULL
)`);
    await q.query(
      `CREATE INDEX ix_lbank_obs_event_detected ON lbank_obs_event (provider_id, detected_at)`,
    );
    await q.query(`CREATE INDEX ix_lbank_obs_event_batch ON lbank_obs_event (source_batch_id)`);
    // Only events detected at or after the provider's cutover belong here.
    await q.query(`CREATE FUNCTION lbank_obs_event_intake_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  c timestamptz;
BEGIN
  SELECT cutover_at INTO c FROM signal_cutover WHERE provider_id = NEW.provider_id;
  IF c IS NULL OR NEW.detected_at < c THEN
    RAISE EXCEPTION 'lbank_obs_event: detected % is before the cutover % (legacy forward test)', NEW.detected_at, c
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_obs_event_intake_guard BEFORE INSERT ON lbank_obs_event FOR EACH ROW EXECUTE FUNCTION lbank_obs_event_intake_guard()`,
    );
    await q.query(`CREATE FUNCTION lbank_obs_event_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ${arr(OBS_EVENT_MUTABLE)}) IS DISTINCT FROM (to_jsonb(OLD) - ${arr(OBS_EVENT_MUTABLE)}) THEN
    RAISE EXCEPTION 'lbank_obs_event %: the signal snapshot is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_obs_event_immutable BEFORE UPDATE ON lbank_obs_event FOR EACH ROW EXECUTE FUNCTION lbank_obs_event_immutable()`,
    );

    // ── Shared LBank Spot candles ───────────────────────────────────────────────────────────
    await q.query(`CREATE TABLE lbank_spot_pair (
  id                integer GENERATED ALWAYS AS IDENTITY,
  symbol            text NOT NULL,
  base              text NOT NULL,
  quote             text NOT NULL,
  first_bar_at      timestamptz,
  synced_until      timestamptz,
  last_fetch_at     timestamptz,
  last_fetch_status text,
  last_error        text,
  unsupported_since timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lbank_spot_pair_pkey PRIMARY KEY (id),
  CONSTRAINT ux_lbank_spot_pair_symbol UNIQUE (symbol)
)`);
    await q.query(`CREATE TABLE lbank_spot_candle (
  pair_id    integer NOT NULL,
  open_time  timestamptz NOT NULL,
  open       numeric NOT NULL,
  high       numeric NOT NULL,
  low        numeric NOT NULL,
  close      numeric NOT NULL,
  volume     numeric NOT NULL,
  fetched_at timestamptz NOT NULL,
  CONSTRAINT lbank_spot_candle_pkey PRIMARY KEY (pair_id, open_time),
  CONSTRAINT lbank_spot_candle_values CHECK (low > 0 AND high >= low AND volume >= 0 AND open > 0 AND close > 0),
  CONSTRAINT lbank_spot_candle_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES lbank_spot_pair (id) ON DELETE RESTRICT
)`);
    await q.query(`CREATE FUNCTION lbank_spot_candle_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lbank_spot_candle (pair %, %): a closed candle is immutable', OLD.pair_id, OLD.open_time
    USING ERRCODE = 'check_violation';
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_spot_candle_immutable BEFORE UPDATE ON lbank_spot_candle FOR EACH ROW EXECUTE FUNCTION lbank_spot_candle_immutable()`,
    );

    await q.query(`CREATE TABLE lbank_market_list_fetch (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  kind           lbank_market_list_kind NOT NULL,
  fetched_at     timestamptz NOT NULL,
  ok             boolean NOT NULL,
  source         text NOT NULL,
  item_count     integer NOT NULL,
  content_sha256 text,
  error          text,
  CONSTRAINT lbank_market_list_fetch_pkey PRIMARY KEY (id)
)`);
    await q.query(
      `CREATE INDEX ix_lbank_market_list_fetch_kind ON lbank_market_list_fetch (kind, fetched_at)`,
    );

    // ── Observations ────────────────────────────────────────────────────────────────────────
    await q.query(`CREATE TABLE lbank_observation (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id               uuid NOT NULL,
  provider_id            text NOT NULL,
  is_live                boolean NOT NULL,
  t0                     timestamptz NOT NULL,
  window_end             timestamptz NOT NULL,
  pair_id                integer,
  pair_symbol            text,
  quote_asset            text,
  mapping_status         lbank_obs_mapping_status NOT NULL,
  mapping_evidence       jsonb NOT NULL,
  spot_status            lbank_obs_listing_status NOT NULL,
  spot_trading           text,
  futures_status         lbank_obs_listing_status NOT NULL,
  eligibility            lbank_obs_eligibility NOT NULL,
  eligibility_evidence   jsonb NOT NULL,
  eligibility_checked_at timestamptz,
  spot_list_fetch_id     bigint,
  futures_list_fetch_id  bigint,
  entry_at               timestamptz,
  entry_price            numeric,
  entry_delay_ms         integer,
  entry_last_trade_at    timestamptz,
  entry_stale            boolean,
  high_price             numeric,
  high_bar_at            timestamptz,
  low_price              numeric,
  low_bar_at             timestamptz,
  max_rise_pct           numeric(65,30),
  max_drop_pct           numeric(65,30),
  low_before_high_price  numeric,
  low_before_high_bar_at timestamptz,
  extreme_order          lbank_obs_extreme_order,
  expected_bars          integer NOT NULL,
  observed_through       timestamptz,
  covered_bars           integer NOT NULL DEFAULT 0,
  traded_bars            integer NOT NULL DEFAULT 0,
  missing_bars           integer NOT NULL DEFAULT 0,
  missing_ranges         jsonb NOT NULL,
  start_unobserved_ms    integer NOT NULL,
  boundary_unobserved_ms integer NOT NULL,
  status                 lbank_obs_status NOT NULL,
  reasons                text[] NOT NULL DEFAULT '{}',
  rules_version          text NOT NULL,
  result_version         integer NOT NULL DEFAULT 0,
  series_sha256          text,
  last_update_at         timestamptz,
  last_attempt_at        timestamptz,
  last_error             text,
  finalized_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lbank_observation_pkey PRIMARY KEY (id),
  CONSTRAINT ux_lbank_observation_event UNIQUE (event_id),
  CONSTRAINT lbank_observation_event_id_fkey FOREIGN KEY (event_id) REFERENCES lbank_obs_event (id) ON DELETE RESTRICT,
  CONSTRAINT lbank_observation_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT lbank_observation_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES lbank_spot_pair (id) ON DELETE RESTRICT,
  CONSTRAINT lbank_observation_spot_list_fetch_id_fkey FOREIGN KEY (spot_list_fetch_id) REFERENCES lbank_market_list_fetch (id) ON DELETE SET NULL,
  CONSTRAINT lbank_observation_futures_list_fetch_id_fkey FOREIGN KEY (futures_list_fetch_id) REFERENCES lbank_market_list_fetch (id) ON DELETE SET NULL
)`);
    await q.query(
      `CREATE INDEX ix_lbank_observation_status ON lbank_observation (provider_id, status)`,
    );
    await q.query(`CREATE INDEX ix_lbank_observation_t0 ON lbank_observation (provider_id, t0)`);
    await q.query(`CREATE INDEX ix_lbank_observation_pair ON lbank_observation (pair_id)`);
    // A finalized observation is frozen (only provenance links cleared by SET NULL may change).
    await q.query(`CREATE FUNCTION lbank_observation_frozen() RETURNS trigger
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
    await q.query(
      `CREATE TRIGGER lbank_observation_frozen BEFORE UPDATE ON lbank_observation FOR EACH ROW EXECUTE FUNCTION lbank_observation_frozen()`,
    );

    await q.query(`CREATE TABLE lbank_observation_result (
  id                     bigint GENERATED ALWAYS AS IDENTITY,
  observation_id         uuid NOT NULL,
  result_version         integer NOT NULL,
  status                 lbank_obs_status NOT NULL,
  eligibility            lbank_obs_eligibility NOT NULL,
  reasons                text[] NOT NULL DEFAULT '{}',
  rules_version          text NOT NULL,
  entry_at               timestamptz,
  entry_price            numeric,
  entry_delay_ms         integer,
  high_price             numeric,
  high_bar_at            timestamptz,
  low_price              numeric,
  low_bar_at             timestamptz,
  max_rise_pct           numeric(65,30),
  max_drop_pct           numeric(65,30),
  low_before_high_price  numeric,
  low_before_high_bar_at timestamptz,
  extreme_order          lbank_obs_extreme_order,
  expected_bars          integer NOT NULL,
  covered_bars           integer NOT NULL,
  traded_bars            integer NOT NULL,
  missing_bars           integer NOT NULL,
  missing_ranges         jsonb NOT NULL,
  series_sha256          text,
  computed_at            timestamptz NOT NULL,
  CONSTRAINT lbank_observation_result_pkey PRIMARY KEY (id),
  CONSTRAINT ux_lbank_observation_result_version UNIQUE (observation_id, result_version),
  CONSTRAINT lbank_observation_result_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES lbank_observation (id) ON DELETE RESTRICT
)`);
    await q.query(`CREATE FUNCTION lbank_observation_result_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lbank_observation_result %: results are append-only', OLD.id
    USING ERRCODE = 'check_violation';
END
$$`);
    await q.query(
      `CREATE TRIGGER lbank_observation_result_immutable BEFORE UPDATE OR DELETE ON lbank_observation_result FOR EACH ROW EXECUTE FUNCTION lbank_observation_result_immutable()`,
    );

    await q.query(`CREATE TABLE lbank_obs_run (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  trigger     text NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  status      lbank_obs_run_status NOT NULL,
  counts      jsonb,
  notes       text[] NOT NULL DEFAULT '{}',
  error       text,
  CONSTRAINT lbank_obs_run_pkey PRIMARY KEY (id),
  CONSTRAINT lbank_obs_run_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await q.query(
      `CREATE INDEX ix_lbank_obs_run_provider ON lbank_obs_run (provider_id, started_at)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of [
      'lbank_obs_run',
      'lbank_observation_result',
      'lbank_observation',
      'lbank_market_list_fetch',
      'lbank_spot_candle',
      'lbank_spot_pair',
      'lbank_obs_event',
      'lbank_obs_intake_run',
      'forward_legacy_closure',
    ])
      await q.query(`DROP TABLE ${table}`);
    await q.query(`DROP TRIGGER forward_event_legacy_intake_guard ON forward_event`);
    await q.query(`DROP TABLE signal_cutover`);
    for (const fn of [
      'lbank_observation_result_immutable',
      'lbank_observation_frozen',
      'lbank_spot_candle_immutable',
      'lbank_obs_event_immutable',
      'lbank_obs_event_intake_guard',
      'forward_event_legacy_intake_guard',
      'signal_cutover_guard',
    ])
      await q.query(`DROP FUNCTION ${fn}()`);
    for (const [name] of [...ENUMS].reverse()) await q.query(`DROP TYPE ${name}`);
  }
}

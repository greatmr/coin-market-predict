import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M008: Star Event Forward Test (docs/forward-test.md). The documented time of each daily High /
 * Low on `daily_metric_revision` (the targeted High-data capture), the automatically managed
 * Forward_Test_Watchlist, events with their immutable detection snapshot, High observations with
 * revisions, versioned outcomes, trigger runs and rejections, and daily update runs. The enum
 * values mirror `modules/forward-test/forward.constants.ts` and `forward-rules.ts`.
 */
const ENUMS: ReadonlyArray<readonly [name: string, values: readonly string[]]> = [
  ['forward_event_status', ['OPEN', 'TRACKING', 'AWAITING_FINAL_DAY', 'FINAL', 'INCOMPLETE']],
  ['forward_high_eligibility', ['FULL_DAY', 'DAY0_POST_SIGNAL', 'DAY0_UNPROVEN', 'INVALID']],
  ['forward_peak_kind', ['EXACT', 'LOWER_BOUND', 'NONE']],
  ['forward_extension_flag', ['TRUE', 'FALSE', 'UNKNOWN']],
  ['forward_time_precision', ['SOURCE_TIME', 'UTC_DAY']],
  ['forward_coverage_status', ['PROVISIONAL', 'COMPLETE', 'INCOMPLETE']],
  ['forward_day0_state', ['PENDING', 'EXACT', 'SHORTCUT', 'UNRESOLVED', 'MISSING']],
  ['forward_update_status', ['running', 'succeeded', 'partial', 'failed']],
];

/** Tracking-state columns of forward_event; everything else is the immutable detection snapshot. */
const MUTABLE_EVENT_COLUMNS = [
  'status',
  'quality_flags',
  'result_version',
  'last_update_at',
  'finalized_at',
  'updated_at',
  // provenance links cleared by ON DELETE SET NULL
  'snapshot_id',
  'trigger_run_id',
];

export class M008ForwardTest1793923200008 implements MigrationInterface {
  name = 'M008ForwardTest1793923200008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE daily_metric_revision ADD COLUMN time_high timestamptz, ADD COLUMN time_low timestamptz`,
    );
    for (const [name, values] of ENUMS)
      await queryRunner.query(
        `CREATE TYPE ${name} AS ENUM (${values.map((v) => `'${v}'`).join(', ')})`,
      );

    await queryRunner.query(`CREATE TABLE forward_test_watchlist (
  provider_id      text NOT NULL,
  cmc_id           integer NOT NULL,
  symbol           text NOT NULL,
  name             text NOT NULL,
  slug             text,
  platform_chain   text,
  platform_address text,
  is_live          boolean NOT NULL,
  first_event_at   timestamptz NOT NULL,
  last_event_at    timestamptz NOT NULL,
  event_count      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forward_test_watchlist_pkey PRIMARY KEY (provider_id, cmc_id),
  CONSTRAINT forward_test_watchlist_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(
      `CREATE INDEX ix_forward_test_watchlist_last_event ON forward_test_watchlist (provider_id, last_event_at)`,
    );

    await queryRunner.query(`CREATE TABLE forward_trigger_run (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id     text NOT NULL,
  batch_id        uuid NOT NULL,
  pipeline_run_id uuid,
  triggered_at    timestamptz NOT NULL,
  queue_status    queue_status,
  batch_status    crawl_status NOT NULL,
  queue_rows      integer NOT NULL,
  created         integer NOT NULL,
  ignored         integer NOT NULL,
  rejected        integer NOT NULL,
  details         jsonb NOT NULL,
  notes           text[] NOT NULL DEFAULT '{}',
  CONSTRAINT forward_trigger_run_pkey PRIMARY KEY (id),
  CONSTRAINT forward_trigger_run_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT forward_trigger_run_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE RESTRICT,
  CONSTRAINT forward_trigger_run_pipeline_run_id_fkey FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_run (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_forward_trigger_run_batch ON forward_trigger_run (batch_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX ix_forward_trigger_run_provider ON forward_trigger_run (provider_id, triggered_at)`,
    );

    await queryRunner.query(`CREATE TABLE forward_update_run (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id     text NOT NULL,
  pipeline_run_id uuid,
  trigger         text NOT NULL,
  update_date     date NOT NULL,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  status          forward_update_status NOT NULL,
  counts          jsonb,
  notes           text[] NOT NULL DEFAULT '{}',
  error           text,
  CONSTRAINT forward_update_run_pkey PRIMARY KEY (id),
  CONSTRAINT forward_update_run_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT forward_update_run_pipeline_run_id_fkey FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_run (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_forward_update_run_provider ON forward_update_run (provider_id, started_at)`,
    );

    await queryRunner.query(`CREATE TABLE forward_event (
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
  trigger_run_id          uuid,
  is_live                 boolean NOT NULL,
  snapshot_price_usd      numeric(38,18) NOT NULL,
  quote_currency          text NOT NULL DEFAULT 'USD',
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
  lbank_pairs             jsonb NOT NULL,
  ruleset_version         text NOT NULL,
  config_version          text NOT NULL,
  inputs_hash             text NOT NULL,
  scan_snapshot           jsonb NOT NULL,
  deadline_168h           timestamptz NOT NULL,
  evaluation_end          timestamptz NOT NULL,
  effective_horizon_hours numeric(65,30) NOT NULL,
  rules_version           text NOT NULL,
  status                  forward_event_status NOT NULL,
  quality_flags           text[] NOT NULL DEFAULT '{}',
  result_version          integer NOT NULL DEFAULT 0,
  last_update_at          timestamptz,
  finalized_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forward_event_pkey PRIMARY KEY (id),
  CONSTRAINT ux_forward_event_key UNIQUE (provider_id, cmc_id, detected_utc_date, star_count),
  CONSTRAINT forward_event_star_count_range CHECK (star_count BETWEEN 1 AND 3),
  CONSTRAINT forward_event_price_positive CHECK (snapshot_price_usd > 0),
  CONSTRAINT forward_event_provider_id_cmc_id_fkey FOREIGN KEY (provider_id, cmc_id) REFERENCES forward_test_watchlist (provider_id, cmc_id) ON DELETE RESTRICT,
  CONSTRAINT forward_event_source_batch_id_fkey FOREIGN KEY (source_batch_id) REFERENCES crawl_batch (id) ON DELETE RESTRICT,
  CONSTRAINT forward_event_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES market_snapshot (id) ON DELETE SET NULL,
  CONSTRAINT forward_event_trigger_run_id_fkey FOREIGN KEY (trigger_run_id) REFERENCES forward_trigger_run (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_forward_event_status ON forward_event (provider_id, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX ix_forward_event_detected ON forward_event (provider_id, detected_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX ix_forward_event_batch ON forward_event (source_batch_id)`,
    );
    // The detection snapshot (reference price, times, batch, scanner fields, window) never changes.
    await queryRunner.query(`CREATE FUNCTION forward_event_immutable_snapshot() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[${MUTABLE_EVENT_COLUMNS.map((c) => `'${c}'`).join(', ')}]::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[${MUTABLE_EVENT_COLUMNS.map((c) => `'${c}'`).join(', ')}]::text[]) THEN
    RAISE EXCEPTION 'forward_event %: the detection snapshot is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await queryRunner.query(
      `CREATE TRIGGER forward_event_immutable_snapshot BEFORE UPDATE ON forward_event FOR EACH ROW EXECUTE FUNCTION forward_event_immutable_snapshot()`,
    );

    await queryRunner.query(`CREATE TABLE forward_trigger_rejection (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  provider_id    text NOT NULL,
  batch_id       uuid NOT NULL,
  trigger_run_id uuid NOT NULL,
  cmc_id         integer,
  symbol         text,
  star_count     integer NOT NULL,
  reasons        text[] NOT NULL DEFAULT '{}',
  observed       jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forward_trigger_rejection_pkey PRIMARY KEY (id),
  CONSTRAINT ux_forward_trigger_rejection UNIQUE (batch_id, cmc_id, star_count),
  CONSTRAINT forward_trigger_rejection_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT forward_trigger_rejection_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE RESTRICT,
  CONSTRAINT forward_trigger_rejection_trigger_run_id_fkey FOREIGN KEY (trigger_run_id) REFERENCES forward_trigger_run (id) ON DELETE CASCADE
)`);
    await queryRunner.query(
      `CREATE INDEX ix_forward_trigger_rejection_provider ON forward_trigger_rejection (provider_id, created_at)`,
    );

    await queryRunner.query(`CREATE TABLE forward_high (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  event_id           uuid NOT NULL,
  date_utc           date NOT NULL,
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  source             text NOT NULL,
  source_revision_id bigint NOT NULL,
  revision           integer NOT NULL,
  high_usd           numeric(38,18),
  time_high          timestamptz,
  quote_currency     text NOT NULL DEFAULT 'USD',
  observed_at        timestamptz NOT NULL,
  eligibility        forward_high_eligibility NOT NULL,
  reason             text,
  is_current         boolean NOT NULL DEFAULT true,
  superseded_at      timestamptz,
  update_run_id      uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forward_high_pkey PRIMARY KEY (id),
  CONSTRAINT ux_forward_high_observation UNIQUE (event_id, period_start, source, source_revision_id),
  CONSTRAINT forward_high_event_id_fkey FOREIGN KEY (event_id) REFERENCES forward_event (id) ON DELETE RESTRICT,
  CONSTRAINT forward_high_source_revision_id_fkey FOREIGN KEY (source_revision_id) REFERENCES daily_metric_revision (id) ON DELETE RESTRICT,
  CONSTRAINT forward_high_update_run_id_fkey FOREIGN KEY (update_run_id) REFERENCES forward_update_run (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_forward_high_event_current ON forward_high (event_id, is_current)`,
    );

    await queryRunner.query(`CREATE TABLE forward_outcome (
  id                      bigint GENERATED ALWAYS AS IDENTITY,
  event_id                uuid NOT NULL,
  result_version          integer NOT NULL,
  revision_reason         text NOT NULL,
  rules_version           text NOT NULL,
  status                  forward_event_status NOT NULL,
  coverage_status         forward_coverage_status NOT NULL,
  peak_kind               forward_peak_kind NOT NULL,
  peak_high_usd           numeric(38,18),
  peak_high_id            bigint,
  peak_date               date,
  peak_at                 timestamptz,
  peak_time_precision     forward_time_precision,
  peak_period_start       timestamptz,
  peak_period_end         timestamptz,
  peak_return_pct         numeric(65,30),
  extension_peak_flag     forward_extension_flag,
  effective_horizon_hours numeric(65,30) NOT NULL,
  day0_state              forward_day0_state NOT NULL,
  expected_days           integer NOT NULL,
  completed_days          integer NOT NULL,
  covered_days            integer NOT NULL,
  missing_dates           text[] NOT NULL DEFAULT '{}',
  invalid_dates           text[] NOT NULL DEFAULT '{}',
  reasons                 text[] NOT NULL DEFAULT '{}',
  high_ids                jsonb NOT NULL,
  content_hash            text NOT NULL,
  finalized_at            timestamptz,
  computed_at             timestamptz NOT NULL,
  update_run_id           uuid,
  CONSTRAINT forward_outcome_pkey PRIMARY KEY (id),
  CONSTRAINT ux_forward_outcome_version UNIQUE (event_id, result_version),
  CONSTRAINT forward_outcome_event_id_fkey FOREIGN KEY (event_id) REFERENCES forward_event (id) ON DELETE RESTRICT,
  CONSTRAINT forward_outcome_peak_high_id_fkey FOREIGN KEY (peak_high_id) REFERENCES forward_high (id) ON DELETE SET NULL,
  CONSTRAINT forward_outcome_update_run_id_fkey FOREIGN KEY (update_run_id) REFERENCES forward_update_run (id) ON DELETE SET NULL
)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'forward_outcome',
      'forward_high',
      'forward_trigger_rejection',
      'forward_event',
      'forward_update_run',
      'forward_trigger_run',
      'forward_test_watchlist',
    ])
      await queryRunner.query(`DROP TABLE ${table}`);
    await queryRunner.query(`DROP FUNCTION forward_event_immutable_snapshot()`);
    for (const [name] of [...ENUMS].reverse()) await queryRunner.query(`DROP TYPE ${name}`);
    await queryRunner.query(
      `ALTER TABLE daily_metric_revision DROP COLUMN time_low, DROP COLUMN time_high`,
    );
  }
}

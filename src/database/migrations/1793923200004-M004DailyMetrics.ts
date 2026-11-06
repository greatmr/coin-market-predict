import type { MigrationInterface, QueryRunner } from 'typeorm';

/** M004: completed UTC daily rows (every revision kept) and per-asset fetch state (PDF p.11). */
export class M004DailyMetrics1793923200004 implements MigrationInterface {
  name = 'M004DailyMetrics1793923200004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE daily_metric_revision (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  provider_id     text NOT NULL,
  cmc_id          integer NOT NULL,
  date_utc        date NOT NULL,
  revision        integer NOT NULL,
  revision_reason text NOT NULL,
  volume_usd      numeric(38,8),
  market_cap_usd  numeric(38,8),
  open_usd        numeric(38,18),
  high_usd        numeric(38,18),
  low_usd         numeric(38,18),
  close_usd       numeric(38,18),
  valid           boolean NOT NULL,
  invalid_reasons text[] NOT NULL DEFAULT '{}',
  period_start    timestamptz,
  period_end      timestamptz,
  source_close_at timestamptz,
  source_fields   jsonb NOT NULL,
  source          text NOT NULL,
  source_params   jsonb NOT NULL,
  response_sha256 text,
  content_hash    text NOT NULL,
  retrieved_at    timestamptz NOT NULL,
  batch_id        uuid,
  CONSTRAINT daily_metric_revision_pkey PRIMARY KEY (id),
  CONSTRAINT ux_daily_metric_revision_number UNIQUE (provider_id, cmc_id, date_utc, revision),
  CONSTRAINT daily_metric_revision_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT daily_metric_revision_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_daily_metric_revision_day ON daily_metric_revision (provider_id, cmc_id, date_utc)`,
    );
    await queryRunner.query(`CREATE TABLE daily_metric (
  provider_id     text NOT NULL,
  cmc_id          integer NOT NULL,
  date_utc        date NOT NULL,
  revision_id     bigint NOT NULL,
  revision        integer NOT NULL,
  volume_usd      numeric(38,8),
  market_cap_usd  numeric(38,8),
  close_usd       numeric(38,18),
  vmc             numeric(65,30),
  valid           boolean NOT NULL,
  invalid_reasons text[] NOT NULL DEFAULT '{}',
  source_close_at timestamptz,
  retrieved_at    timestamptz NOT NULL,
  source          text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_metric_pkey PRIMARY KEY (provider_id, cmc_id, date_utc),
  CONSTRAINT ux_daily_metric_revision UNIQUE (revision_id),
  CONSTRAINT daily_metric_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT daily_metric_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES daily_metric_revision (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(`CREATE TABLE daily_fetch_state (
  provider_id          text NOT NULL,
  cmc_id               integer NOT NULL,
  last_attempt_at      timestamptz NOT NULL,
  last_success_at      timestamptz,
  last_status          daily_fetch_status NOT NULL,
  last_error           text,
  rows_returned        integer NOT NULL DEFAULT 0,
  latest_date_returned date,
  CONSTRAINT daily_fetch_state_pkey PRIMARY KEY (provider_id, cmc_id),
  CONSTRAINT daily_fetch_state_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['daily_fetch_state', 'daily_metric', 'daily_metric_revision'])
      await queryRunner.query(`DROP TABLE ${table}`);
  }
}

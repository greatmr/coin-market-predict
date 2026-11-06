import type { MigrationInterface, QueryRunner } from 'typeorm';

/** M002: providers and source health, durable app state, the job lease, pipeline runs and Telegram delivery. */
export class M002Platform1793923200002 implements MigrationInterface {
  name = 'M002Platform1793923200002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE provider (
  id            text NOT NULL,
  name          text NOT NULL,
  access_method provider_access_method NOT NULL,
  is_live       boolean NOT NULL,
  base_url      text,
  terms_url     text,
  attribution   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_pkey PRIMARY KEY (id)
)`);
    await queryRunner.query(`CREATE TABLE source_health (
  provider_id          text NOT NULL,
  state                circuit_state NOT NULL DEFAULT 'closed',
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_denials  integer NOT NULL DEFAULT 0,
  opened_at            timestamptz,
  retry_after_until    timestamptz,
  suspended_reason     text,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  last_status_code     integer,
  budget_period_start  timestamptz,
  budget_used          integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_health_pkey PRIMARY KEY (provider_id),
  CONSTRAINT source_health_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(`CREATE TABLE app_state (
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_state_pkey PRIMARY KEY (key)
)`);
    await queryRunner.query(`CREATE TABLE job_lease (
  name         text NOT NULL,
  holder       text NOT NULL,
  acquired_at  timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  CONSTRAINT job_lease_pkey PRIMARY KEY (name)
)`);
    await queryRunner.query(`CREATE TABLE pipeline_run (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  slot_time     timestamptz NOT NULL,
  provider_id   text NOT NULL,
  status        pipeline_run_status NOT NULL,
  current_stage text,
  attempt       integer NOT NULL DEFAULT 1,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  coverage      jsonb,
  metrics       jsonb,
  error         text,
  is_live_data  boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_run_pkey PRIMARY KEY (id),
  CONSTRAINT ux_pipeline_run_slot UNIQUE (kind, slot_time, provider_id),
  CONSTRAINT pipeline_run_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(`CREATE INDEX ix_pipeline_run_started ON pipeline_run (started_at)`);
    await queryRunner.query(`CREATE TABLE pipeline_stage (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL,
  stage       text NOT NULL,
  status      pipeline_stage_status NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  attempts    integer NOT NULL DEFAULT 1,
  detail      jsonb,
  error       text,
  CONSTRAINT pipeline_stage_pkey PRIMARY KEY (id),
  CONSTRAINT ux_pipeline_stage_run_stage UNIQUE (run_id, stage),
  CONSTRAINT pipeline_stage_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_run (id) ON DELETE CASCADE
)`);
    await queryRunner.query(`CREATE TABLE telegram_delivery (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL,
  report_hash         text NOT NULL,
  part_index          integer NOT NULL,
  part_count          integer NOT NULL,
  chat_id             text NOT NULL,
  mode                telegram_delivery_mode NOT NULL,
  status              telegram_delivery_status NOT NULL,
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  last_error          text,
  telegram_message_id text,
  text                text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  CONSTRAINT telegram_delivery_pkey PRIMARY KEY (id),
  CONSTRAINT ux_telegram_delivery_part UNIQUE (report_hash, part_index, chat_id),
  CONSTRAINT telegram_delivery_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_run (id) ON DELETE CASCADE
)`);
    await queryRunner.query(
      `CREATE INDEX ix_telegram_delivery_due ON telegram_delivery (status, next_attempt_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'telegram_delivery',
      'pipeline_stage',
      'pipeline_run',
      'job_lease',
      'app_state',
      'source_health',
      'provider',
    ]) {
      await queryRunner.query(`DROP TABLE ${table}`);
    }
  }
}

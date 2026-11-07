import type { MigrationInterface, QueryRunner } from 'typeorm';

/** M006: Tier 1 scans and results (PDF p.12–17) and the append-only human review records (p.15, p.24–27). */
export class M006ScanAndReviews1793923200006 implements MigrationInterface {
  name = 'M006ScanAndReviews1793923200006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE scan_run (
  batch_id          uuid NOT NULL,
  provider_id       text NOT NULL,
  is_live           boolean NOT NULL,
  ruleset_version   text NOT NULL,
  config_version    text NOT NULL,
  overrides_version text NOT NULL,
  attempts          integer NOT NULL DEFAULT 1,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  status            scan_status NOT NULL,
  as_of             timestamptz NOT NULL,
  queue_status      queue_status,
  counts            jsonb,
  warnings          text[] NOT NULL DEFAULT '{}',
  lbank_crawl_id    uuid,
  export_status     export_status,
  export_path       text,
  export_files      jsonb,
  exported_at       timestamptz,
  error             text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_run_pkey PRIMARY KEY (batch_id),
  CONSTRAINT scan_run_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE RESTRICT,
  CONSTRAINT scan_run_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT scan_run_lbank_crawl_id_fkey FOREIGN KEY (lbank_crawl_id) REFERENCES venue_crawl (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_scan_run_provider_as_of ON scan_run (provider_id, as_of)`,
    );
    await queryRunner.query(`CREATE TABLE scan_result (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  batch_id            uuid NOT NULL,
  provider_id         text NOT NULL,
  cmc_id              integer NOT NULL,
  symbol              text NOT NULL,
  name                text NOT NULL,
  slug                text,
  rank                integer,
  date_added          timestamptz,
  age_days            numeric(14,6),
  price_usd           numeric(38,18),
  cap_usd             numeric(38,8),
  volume_24h_usd      numeric(38,8),
  observed_at         timestamptz,
  crawled_at          timestamptz NOT NULL,
  current_status      current_status NOT NULL,
  current_reason      text,
  current_vmc         numeric(65,30),
  vmc_3d_avg          numeric(65,30),
  vmc_7d_avg          numeric(65,30),
  vmc_14d_avg         numeric(65,30),
  vmc_30d_avg         numeric(65,30),
  avg_3d_reason       text,
  avg_7d_reason       text,
  avg_14d_reason      text,
  avg_30d_reason      text,
  multiple_3d         numeric(65,30),
  multiple_7d         numeric(65,30),
  multiple_30d        numeric(65,30),
  pass_3d             pass_status NOT NULL,
  pass_7d             pass_status NOT NULL,
  pass_30d            pass_status NOT NULL,
  reason_3d           text,
  reason_7d           text,
  reason_30d          text,
  stars               integer NOT NULL,
  eligibility_status  eligibility_status NOT NULL,
  eligibility_reasons text[] NOT NULL DEFAULT '{}',
  asset_class         tier1_class NOT NULL,
  class_source        text,
  lbank_status        lbank_status NOT NULL,
  lbank_reason        text,
  lbank_pairs         jsonb NOT NULL,
  venue_review        venue_review NOT NULL,
  venue_flags         text[] NOT NULL DEFAULT '{}',
  flags               text[] NOT NULL DEFAULT '{}',
  in_queue            boolean NOT NULL DEFAULT false,
  queue_order         integer,
  diagnostics         jsonb,
  daily_window        jsonb,
  inputs_hash         text NOT NULL,
  ruleset_version     text NOT NULL,
  config_version      text NOT NULL,
  computed_at         timestamptz NOT NULL,
  CONSTRAINT scan_result_pkey PRIMARY KEY (id),
  CONSTRAINT ux_scan_result_asset UNIQUE (batch_id, cmc_id),
  CONSTRAINT scan_result_stars_range CHECK (stars BETWEEN 0 AND 3),
  CONSTRAINT scan_result_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES scan_run (batch_id) ON DELETE RESTRICT,
  CONSTRAINT scan_result_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(
      `CREATE INDEX ix_scan_result_eligibility ON scan_result (batch_id, eligibility_status)`,
    );
    await queryRunner.query(
      `CREATE INDEX ix_scan_result_queue ON scan_result (batch_id, in_queue)`,
    );
    await queryRunner.query(
      `CREATE INDEX ix_scan_result_asset_history ON scan_result (provider_id, cmc_id, crawled_at)`,
    );
    await queryRunner.query(`CREATE TABLE review (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id         text NOT NULL,
  cmc_id              integer NOT NULL,
  batch_id            uuid NOT NULL,
  revision            integer NOT NULL,
  supersedes_id       uuid,
  reviewer            text NOT NULL,
  reviewed_at         timestamptz NOT NULL,
  venue_decision      venue_review NOT NULL,
  venue_note          text,
  event_day           event_day NOT NULL,
  lbank_pair          text,
  chart_exchange      text,
  chart_symbol        text,
  chart_quote         text,
  chart_url           text,
  chart_timezone      text,
  chart_proxy_reason  text,
  chart_timestamp     timestamptz,
  range_low           judgment,
  chart_history       judgment,
  prior_pump_response judgment,
  candle_state        candle_state,
  market_regime       market_regime,
  final_decision      final_decision NOT NULL,
  rationale           text,
  plan                jsonb,
  plan_status         plan_status,
  validation          jsonb NOT NULL,
  tier1_snapshot      jsonb NOT NULL,
  CONSTRAINT review_pkey PRIMARY KEY (id),
  CONSTRAINT ux_review_revision UNIQUE (provider_id, cmc_id, batch_id, revision),
  CONSTRAINT review_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT review_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE RESTRICT,
  CONSTRAINT review_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES review (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(
      `CREATE INDEX ix_review_asset ON review (provider_id, cmc_id, reviewed_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['review', 'scan_result', 'scan_run'])
      await queryRunner.query(`DROP TABLE ${table}`);
  }
}

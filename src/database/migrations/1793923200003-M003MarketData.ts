import type { MigrationInterface, QueryRunner } from 'typeorm';

/** M003: canonical assets and identities, discovery runs, crawl batches, hourly snapshots, CMC metadata. */
export class M003MarketData1793923200003 implements MigrationInterface {
  name = 'M003MarketData1793923200003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE asset (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  symbol           text NOT NULL,
  asset_class      asset_class NOT NULL DEFAULT 'unknown',
  class_source     text,
  underlying_asset text,
  is_benchmark     boolean NOT NULL DEFAULT false,
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  delisted_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_pkey PRIMARY KEY (id)
)`);
    await queryRunner.query(`CREATE INDEX ix_asset_symbol ON asset (symbol)`);
    await queryRunner.query(`CREATE INDEX ix_asset_class ON asset (asset_class)`);
    await queryRunner.query(`CREATE TABLE asset_identity (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  asset_id          uuid NOT NULL,
  provider_id       text NOT NULL,
  provider_asset_id text NOT NULL,
  source_url        text,
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  delisted_at       timestamptz,
  CONSTRAINT asset_identity_pkey PRIMARY KEY (id),
  CONSTRAINT ux_asset_identity_provider_asset UNIQUE (provider_id, provider_asset_id),
  CONSTRAINT asset_identity_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES asset (id) ON DELETE RESTRICT,
  CONSTRAINT asset_identity_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(`CREATE INDEX ix_asset_identity_asset ON asset_identity (asset_id)`);
    await queryRunner.query(`CREATE TABLE asset_contract (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  asset_id         uuid NOT NULL,
  chain            text NOT NULL,
  contract_address text NOT NULL,
  provider_id      text NOT NULL,
  decimals         integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_contract_pkey PRIMARY KEY (id),
  CONSTRAINT ux_asset_contract_chain_address UNIQUE (chain, contract_address),
  CONSTRAINT asset_contract_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES asset (id) ON DELETE RESTRICT,
  CONSTRAINT asset_contract_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(`CREATE INDEX ix_asset_contract_asset ON asset_contract (asset_id)`);
    await queryRunner.query(`CREATE TABLE discovery_run (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id       text NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  status            discovery_status NOT NULL,
  pages_fetched     integer NOT NULL DEFAULT 0,
  assets_seen       integer NOT NULL DEFAULT 0,
  new_assets        integer NOT NULL DEFAULT 0,
  delisted_assets   integer NOT NULL DEFAULT 0,
  source_total      integer,
  coverage_complete boolean NOT NULL DEFAULT false,
  requests_used     integer NOT NULL DEFAULT 0,
  error             text,
  notes             jsonb,
  CONSTRAINT discovery_run_pkey PRIMARY KEY (id),
  CONSTRAINT discovery_run_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(
      `CREATE INDEX ix_discovery_run_provider_started ON discovery_run (provider_id, started_at)`,
    );
    await queryRunner.query(`CREATE TABLE crawl_batch (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id        text NOT NULL,
  slot_time          timestamptz NOT NULL,
  pipeline_run_id    uuid,
  is_live            boolean NOT NULL,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  crawled_at         timestamptz NOT NULL,
  source_updated_min timestamptz,
  source_updated_max timestamptz,
  status             crawl_status NOT NULL,
  status_reasons     text[] NOT NULL DEFAULT '{}',
  listed_total       integer,
  collected          integer NOT NULL,
  field_counts       jsonb NOT NULL,
  missing_ranks      integer[] NOT NULL DEFAULT '{}',
  duplicate_ranks    integer[] NOT NULL DEFAULT '{}',
  errors             jsonb,
  notes              text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crawl_batch_pkey PRIMARY KEY (id),
  CONSTRAINT ux_crawl_batch_slot UNIQUE (provider_id, slot_time),
  CONSTRAINT crawl_batch_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT crawl_batch_pipeline_run_id_fkey FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_run (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_crawl_batch_provider_crawled ON crawl_batch (provider_id, crawled_at)`,
    );
    await queryRunner.query(`CREATE TABLE market_snapshot (
  id                      bigint GENERATED ALWAYS AS IDENTITY,
  asset_id                uuid NOT NULL,
  provider_id             text NOT NULL,
  provider_asset_id       text NOT NULL,
  slot_time               timestamptz NOT NULL,
  collected_at            timestamptz NOT NULL,
  observed_at             timestamptz,
  source_url              text NOT NULL,
  quote_currency          text NOT NULL DEFAULT 'USD',
  price                   numeric(38,18),
  market_cap              numeric(38,4),
  market_cap_provenance   market_cap_provenance NOT NULL,
  fully_diluted_valuation numeric(38,4),
  circulating_supply      numeric(38,8),
  supply_provenance       supply_provenance NOT NULL,
  volume_rolling_24h      numeric(38,4),
  volume_hourly           numeric(38,4),
  volume_hourly_source    text,
  provider_change_pct_1h  numeric(20,8),
  provider_change_pct_24h numeric(20,8),
  provider_change_pct_7d  numeric(20,8),
  bid_ask_spread_pct      numeric(20,8),
  depth_plus_2pct_usd     numeric(38,4),
  depth_minus_2pct_usd    numeric(38,4),
  liquidity_source        text,
  rank                    integer,
  date_added              timestamptz,
  tags                    text[] NOT NULL DEFAULT '{}',
  quality_flags           text[] NOT NULL DEFAULT '{}',
  completeness            numeric(5,4) NOT NULL,
  freshness_seconds       integer,
  is_stale                boolean NOT NULL DEFAULT false,
  null_reasons            jsonb NOT NULL,
  pipeline_run_id         uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_snapshot_pkey PRIMARY KEY (id),
  CONSTRAINT ux_market_snapshot_observation UNIQUE (provider_id, provider_asset_id, slot_time, quote_currency),
  CONSTRAINT market_snapshot_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES asset (id) ON DELETE RESTRICT,
  CONSTRAINT market_snapshot_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT market_snapshot_pipeline_run_id_fkey FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_run (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_market_snapshot_asset_slot ON market_snapshot (asset_id, slot_time)`,
    );
    await queryRunner.query(`CREATE INDEX ix_market_snapshot_slot ON market_snapshot (slot_time)`);
    await queryRunner.query(`CREATE TABLE cmc_asset (
  provider_id      text NOT NULL,
  cmc_id           integer NOT NULL,
  symbol           text NOT NULL,
  name             text NOT NULL,
  slug             text,
  tags             text[] NOT NULL DEFAULT '{}',
  date_added       timestamptz,
  platform_chain   text,
  platform_address text,
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  last_batch_id    uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cmc_asset_pkey PRIMARY KEY (provider_id, cmc_id),
  CONSTRAINT cmc_asset_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT cmc_asset_last_batch_id_fkey FOREIGN KEY (last_batch_id) REFERENCES crawl_batch (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_cmc_asset_provider_symbol ON cmc_asset (provider_id, symbol)`,
    );
    await queryRunner.query(`CREATE TABLE cmc_asset_change (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  provider_id text NOT NULL,
  cmc_id      integer NOT NULL,
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  batch_id    uuid,
  observed_at timestamptz NOT NULL,
  CONSTRAINT cmc_asset_change_pkey PRIMARY KEY (id),
  CONSTRAINT cmc_asset_change_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT cmc_asset_change_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_cmc_asset_change_asset ON cmc_asset_change (provider_id, cmc_id, observed_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'cmc_asset_change',
      'cmc_asset',
      'market_snapshot',
      'crawl_batch',
      'discovery_run',
      'asset_contract',
      'asset_identity',
      'asset',
    ]) {
      await queryRunner.query(`DROP TABLE ${table}`);
    }
  }
}

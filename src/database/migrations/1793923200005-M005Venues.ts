import type { MigrationInterface, QueryRunner } from 'typeorm';

/** M005: LBank / CMC Markets venue crawls, LBank listing events, reviewer decisions and mapping tasks. */
export class M005Venues1793923200005 implements MigrationInterface {
  name = 'M005Venues1793923200005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE venue_crawl (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id     text NOT NULL,
  kind            venue_crawl_kind NOT NULL,
  cmc_id          integer,
  batch_id        uuid,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL,
  status          crawl_status NOT NULL,
  expected_count  integer,
  fetched_count   integer NOT NULL,
  requests        integer NOT NULL DEFAULT 0,
  pairs           jsonb NOT NULL,
  summary         jsonb,
  source          text NOT NULL,
  source_params   jsonb NOT NULL,
  response_sha256 text[] NOT NULL DEFAULT '{}',
  error           text,
  notes           text[] NOT NULL DEFAULT '{}',
  CONSTRAINT venue_crawl_pkey PRIMARY KEY (id),
  CONSTRAINT venue_crawl_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT venue_crawl_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_venue_crawl_kind ON venue_crawl (provider_id, kind, finished_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX ix_venue_crawl_asset ON venue_crawl (provider_id, kind, cmc_id, finished_at)`,
    );
    await queryRunner.query(`CREATE TABLE venue_pair_event (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  provider_id text NOT NULL,
  exchange    text NOT NULL,
  cmc_id      integer NOT NULL,
  market_pair text NOT NULL,
  event       pair_event NOT NULL,
  crawl_id    uuid NOT NULL,
  at          timestamptz NOT NULL,
  CONSTRAINT venue_pair_event_pkey PRIMARY KEY (id),
  CONSTRAINT venue_pair_event_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT venue_pair_event_crawl_id_fkey FOREIGN KEY (crawl_id) REFERENCES venue_crawl (id) ON DELETE RESTRICT
)`);
    await queryRunner.query(
      `CREATE INDEX ix_venue_pair_event_pair ON venue_pair_event (provider_id, exchange, cmc_id, at)`,
    );
    await queryRunner.query(`CREATE TABLE venue_decision (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  cmc_id      integer NOT NULL,
  exchange    text NOT NULL,
  market_pair text,
  decision    venue_decision_kind NOT NULL,
  reviewer    text NOT NULL,
  note        text,
  batch_id    uuid,
  decided_at  timestamptz NOT NULL,
  CONSTRAINT venue_decision_pkey PRIMARY KEY (id),
  CONSTRAINT venue_decision_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT venue_decision_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_venue_decision_asset ON venue_decision (provider_id, cmc_id, exchange, decided_at)`,
    );
    await queryRunner.query(`CREATE TABLE venue_mapping_task (
  id                      uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id             text NOT NULL,
  cmc_id                  integer NOT NULL,
  exchange                text NOT NULL,
  market_pair             text NOT NULL,
  kind                    mapping_task_kind NOT NULL,
  evidence                jsonb NOT NULL,
  status                  mapping_task_status NOT NULL,
  first_seen_batch_id     uuid,
  last_seen_batch_id      uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  resolved_by_decision_id uuid,
  CONSTRAINT venue_mapping_task_pkey PRIMARY KEY (id),
  CONSTRAINT ux_venue_mapping_task_pair UNIQUE (provider_id, cmc_id, exchange, market_pair, kind),
  CONSTRAINT venue_mapping_task_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT venue_mapping_task_first_seen_batch_id_fkey FOREIGN KEY (first_seen_batch_id) REFERENCES crawl_batch (id) ON DELETE SET NULL,
  CONSTRAINT venue_mapping_task_last_seen_batch_id_fkey FOREIGN KEY (last_seen_batch_id) REFERENCES crawl_batch (id) ON DELETE SET NULL,
  CONSTRAINT venue_mapping_task_resolved_by_decision_id_fkey FOREIGN KEY (resolved_by_decision_id) REFERENCES venue_decision (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_venue_mapping_task_status ON venue_mapping_task (provider_id, status)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['venue_mapping_task', 'venue_decision', 'venue_pair_event', 'venue_crawl'])
      await queryRunner.query(`DROP TABLE ${table}`);
  }
}

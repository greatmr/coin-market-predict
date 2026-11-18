import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M013: the forward test's signal day from CMC hourly Highs (gap U1, docs/forward-test.md § 6,
 * rules `star-forward-2`). Adds `forward_day0_capture` (one retrieval of a tracked coin's hourly
 * OHLC for one signal date, immutable) and lets a `forward_high` row reference such a capture
 * instead of a daily revision (exactly one of the two), with the new eligibility `DAY0_HOURLY`.
 * Existing rows are unchanged: every one keeps its daily revision.
 *
 * `ALTER TYPE … ADD VALUE` runs inside the migration transaction (PostgreSQL ≥ 12); the new value is
 * only used after it commits.
 */
const ELIGIBILITY_BEFORE = ['FULL_DAY', 'DAY0_POST_SIGNAL', 'DAY0_UNPROVEN', 'INVALID'];

export class M013ForwardDay0Hourly1793923200013 implements MigrationInterface {
  name = 'M013ForwardDay0Hourly1793923200013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE forward_high_eligibility ADD VALUE IF NOT EXISTS 'DAY0_HOURLY'`,
    );
    await queryRunner.query(`CREATE TABLE forward_day0_capture (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  provider_id      text NOT NULL,
  cmc_id           integer NOT NULL,
  date_utc         date NOT NULL,
  source           text NOT NULL,
  params           jsonb NOT NULL,
  response_sha256  text NOT NULL,
  retrieved_at     timestamptz NOT NULL,
  candles          jsonb NOT NULL,
  complete         boolean NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forward_day0_capture_pkey PRIMARY KEY (id),
  CONSTRAINT ux_forward_day0_capture UNIQUE (provider_id, cmc_id, date_utc, response_sha256),
  CONSTRAINT forward_day0_capture_provider_id_cmc_id_fkey FOREIGN KEY (provider_id, cmc_id) REFERENCES forward_test_watchlist (provider_id, cmc_id) ON DELETE RESTRICT
)`);
    await queryRunner.query(
      `ALTER TABLE forward_high ALTER COLUMN source_revision_id DROP NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE forward_high ADD COLUMN day0_capture_id bigint`);
    await queryRunner.query(
      `ALTER TABLE forward_high ADD CONSTRAINT forward_high_day0_capture_id_fkey FOREIGN KEY (day0_capture_id) REFERENCES forward_day0_capture (id) ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `ALTER TABLE forward_high ADD CONSTRAINT ux_forward_high_day0_capture UNIQUE (event_id, day0_capture_id, eligibility)`,
    );
    await queryRunner.query(
      `ALTER TABLE forward_high ADD CONSTRAINT forward_high_one_source_row CHECK ((source_revision_id IS NULL) <> (day0_capture_id IS NULL))`,
    );
  }

  /**
   * Fails while any High was measured from an hourly capture (NOT NULL and the enum cast): those
   * rows are never deleted silently. Do not revert on real data.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE forward_high DROP CONSTRAINT forward_high_one_source_row`);
    await queryRunner.query(
      `ALTER TABLE forward_high DROP CONSTRAINT ux_forward_high_day0_capture`,
    );
    await queryRunner.query(
      `ALTER TABLE forward_high DROP CONSTRAINT forward_high_day0_capture_id_fkey`,
    );
    await queryRunner.query(
      `ALTER TABLE forward_high ALTER COLUMN source_revision_id SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE forward_high DROP COLUMN day0_capture_id`);
    await queryRunner.query(`DROP TABLE forward_day0_capture`);
    await queryRunner.query(
      `ALTER TYPE forward_high_eligibility RENAME TO forward_high_eligibility_m013`,
    );
    await queryRunner.query(
      `CREATE TYPE forward_high_eligibility AS ENUM (${ELIGIBILITY_BEFORE.map((v) => `'${v}'`).join(', ')})`,
    );
    await queryRunner.query(
      `ALTER TABLE forward_high ALTER COLUMN eligibility TYPE forward_high_eligibility USING eligibility::text::forward_high_eligibility`,
    );
    await queryRunner.query(`DROP TYPE forward_high_eligibility_m013`);
  }
}

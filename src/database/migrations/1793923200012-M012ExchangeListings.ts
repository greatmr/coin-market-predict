import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M012: two more venue crawl kinds for the exchange listing attributes of ADR-0007 — LBank's
 * Futures markets list (`lbank_futures_pairs`, CMC categories perpetual and futures) and Bithumb's
 * Spot markets list (`bithumb_spot_pairs`). Stored in `venue_crawl` like the LBank Spot list; no
 * Tier 1 rule reads them, so RULESET_VERSION is unchanged.
 *
 * `ALTER TYPE … ADD VALUE` runs inside the migration transaction (PostgreSQL ≥ 12); the new values
 * are only used after it commits.
 */
const BEFORE = ['lbank_spot_pairs', 'asset_markets'];

export class M012ExchangeListings1793923200012 implements MigrationInterface {
  name = 'M012ExchangeListings1793923200012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE venue_crawl_kind ADD VALUE IF NOT EXISTS 'lbank_futures_pairs'`,
    );
    await queryRunner.query(
      `ALTER TYPE venue_crawl_kind ADD VALUE IF NOT EXISTS 'bithumb_spot_pairs'`,
    );
  }

  /**
   * PostgreSQL cannot drop an enum value, so the type is rebuilt without them. The cast fails while
   * any crawl of the new kinds exists: they are never deleted silently.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE venue_crawl_kind RENAME TO venue_crawl_kind_m012`);
    await queryRunner.query(
      `CREATE TYPE venue_crawl_kind AS ENUM (${BEFORE.map((v) => `'${v}'`).join(', ')})`,
    );
    await queryRunner.query(
      `ALTER TABLE venue_crawl ALTER COLUMN kind TYPE venue_crawl_kind USING kind::text::venue_crawl_kind`,
    );
    await queryRunner.query(`DROP TYPE venue_crawl_kind_m012`);
  }
}

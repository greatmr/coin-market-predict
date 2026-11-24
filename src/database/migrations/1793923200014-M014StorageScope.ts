import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M014: storage scope (operator decision D4, 2026-11-24, ADR-0008). Every listed coin is still read
 * each hour, but only ranks 1–1200 are stored as snapshots and only Review Queue rows as scan
 * results. `crawl_batch.stored` records how many snapshots a slot kept, next to `collected` (every
 * coin read). Additive only: earlier batches keep NULL, meaning every collected coin was stored.
 *
 * The cleanup of rows stored under the earlier policy is deliberately not a migration (migrations
 * run on every deploy): it is the operator's `storage:prune`, after a backup
 * (docs/operator-guide.md § Storage cleanup).
 */
export class M014StorageScope1793923200014 implements MigrationInterface {
  name = 'M014StorageScope1793923200014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE crawl_batch ADD COLUMN stored integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE crawl_batch DROP COLUMN stored`);
  }
}

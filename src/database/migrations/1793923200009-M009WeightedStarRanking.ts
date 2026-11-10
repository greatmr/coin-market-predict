import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M009: Weighted Star Ranking (addendum `weighted_star_v1`, 10 Nov 2026). Ranking fields on every
 * scan result, the ranking version on each scan run, and the same fields in the forward-test
 * detection snapshot. All nullable without defaults: adding them rewrites no table, and rows from
 * before the ranking keep NULL instead of a back-filled score. The forward_event immutability
 * trigger (M008) covers the new columns automatically.
 */
const RANKING_COLUMNS = `ADD COLUMN weighted_pass_points integer,
  ADD COLUMN score_complete boolean,
  ADD COLUMN weighted_strength numeric(65,30),
  ADD COLUMN ranking_ruleset_version text`;

export class M009WeightedStarRanking1793923200009 implements MigrationInterface {
  name = 'M009WeightedStarRanking1793923200009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE scan_result ${RANKING_COLUMNS}`);
    await queryRunner.query(`ALTER TABLE scan_run ADD COLUMN ranking_ruleset_version text`);
    await queryRunner.query(`ALTER TABLE forward_event ${RANKING_COLUMNS}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const drop = `DROP COLUMN ranking_ruleset_version, DROP COLUMN weighted_strength,
  DROP COLUMN score_complete, DROP COLUMN weighted_pass_points`;
    await queryRunner.query(`ALTER TABLE forward_event ${drop}`);
    await queryRunner.query(`ALTER TABLE scan_run DROP COLUMN ranking_ruleset_version`);
    await queryRunner.query(`ALTER TABLE scan_result ${drop}`);
  }
}

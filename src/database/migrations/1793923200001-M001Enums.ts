import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M001: every PostgreSQL enum type. The value lists mirror the `*_STATUSES`-style constants next to
 * the entities and in the strategy module (`modules/strategy/strategy.constants.ts`); a value added
 * there needs `ALTER TYPE … ADD VALUE` in a new migration. Requires PostgreSQL ≥ 13
 * (`gen_random_uuid()` is built in, no extension is created).
 */
const ENUMS: ReadonlyArray<readonly [name: string, values: readonly string[]]> = [
  // sources & platform
  ['provider_access_method', ['official_api', 'website', 'fixture', 'public_dataset']],
  ['circuit_state', ['closed', 'open', 'half_open', 'suspended']],
  ['pipeline_run_status', ['running', 'succeeded', 'partial', 'failed', 'skipped', 'missed']],
  ['pipeline_stage_status', ['running', 'succeeded', 'failed', 'skipped']],
  ['telegram_delivery_mode', ['live', 'dry_run']],
  ['telegram_delivery_status', ['pending', 'sent', 'failed', 'dry_run']],
  // market data
  [
    'asset_class',
    ['regular', 'stablecoin', 'tokenized', 'wrapped', 'bridged', 'staked', 'unknown'],
  ],
  ['discovery_status', ['running', 'succeeded', 'partial', 'failed']],
  [
    'market_cap_provenance',
    ['provider_reported', 'calculated_from_circulating_supply', 'unavailable'],
  ],
  ['supply_provenance', ['provider_reported', 'unavailable']],
  ['crawl_status', ['COMPLETE', 'INCOMPLETE', 'FAILED']],
  // Tier 1 inputs
  ['daily_fetch_status', ['ok', 'partial', 'failed', 'no_data']],
  ['venue_crawl_kind', ['lbank_spot_pairs', 'asset_markets']],
  ['pair_event', ['LISTED', 'ABSENT']],
  [
    'venue_decision_kind',
    ['VERIFIED_TRADABLE', 'NOT_TRADABLE', 'MAPPING_CONFIRMED', 'MAPPING_REJECTED'],
  ],
  ['mapping_task_kind', ['SYMBOL_MISMATCH', 'TICKER_MULTIPLE_IDS']],
  ['mapping_task_status', ['OPEN', 'RESOLVED']],
  // Tier 1 results (strategy)
  ['scan_status', ['running', 'succeeded', 'failed']],
  [
    'queue_status',
    ['PUBLISHED', 'WITHHELD_INCOMPLETE_BATCH', 'WITHHELD_LBANK_UNAVAILABLE', 'EMPTY'],
  ],
  ['export_status', ['succeeded', 'failed']],
  ['current_status', ['OK', 'STALE', 'TIMESTAMP_UNVERIFIED', 'MISMATCHED', 'MISSING', 'INVALID']],
  ['pass_status', ['YES', 'NO', 'N/A']],
  ['eligibility_status', ['ELIGIBLE', 'EXCLUDED', 'NEEDS_REVIEW']],
  ['tier1_class', ['regular', 'stablecoin', 'tokenized', 'ambiguous']],
  ['lbank_status', ['VERIFIED', 'PAIR_LISTED_UNVERIFIED', 'NOT_LISTED', 'NOT_TRADABLE', 'UNKNOWN']],
  // human review (Tier 1 venue decision, Tier 2 chart review and trade plan)
  ['venue_review', ['ACCEPT', 'REJECT', 'PENDING']],
  ['event_day', ['FIRST', 'SECOND', 'LATER', 'UNKNOWN']],
  ['judgment', ['PASS', 'REJECT', 'UNCERTAIN']],
  ['candle_state', ['PRE_MOVE', 'ALREADY_PUMPED', 'UNCERTAIN']],
  ['market_regime', ['FAVORABLE', 'UNFAVORABLE', 'UNCERTAIN']],
  ['final_decision', ['REVIEW', 'NO_TRADE', 'PLAN_READY']],
  ['plan_status', ['COMPLETE', 'INCOMPLETE']],
];

export class M001Enums1793923200001 implements MigrationInterface {
  name = 'M001Enums1793923200001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, values] of ENUMS) {
      await queryRunner.query(
        `CREATE TYPE ${name} AS ENUM (${values.map((v) => `'${v}'`).join(', ')})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of [...ENUMS].reverse()) await queryRunner.query(`DROP TYPE ${name}`);
  }
}

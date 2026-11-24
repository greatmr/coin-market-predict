import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';

import { BigintColumn } from '../../../common/entities/bigint.js';
import { CreatedAtColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../../ingestion/entities/market-snapshot.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import { PASS_STATUSES, type PassStatus, type ResolvedPair } from '../../strategy/index.js';

import { ObsIntakeRun } from './obs-intake-run.entity.js';

/**
 * A CMC star event detected at or after the cutover (docs/lbank-spot-observation.md § 2): the first
 * priced 1/2/3-star Review Queue sighting per (provider, CMC id, UTC date, star count), by the same
 * rule as the legacy forward test (`star-events/star-event.rules.ts`). The whole row is the
 * immutable signal snapshot (a database trigger refuses changes); a trigger also refuses any event
 * detected before the provider's cutover. The CMC price is kept for context only — it is never an
 * LBank entry or part of an LBank return.
 */
@Entity({ name: 'lbank_obs_event' })
@Unique('ux_lbank_obs_event_key', ['providerId', 'cmcId', 'detectedUtcDate', 'starCount'])
@Index('ix_lbank_obs_event_detected', ['providerId', 'detectedAt'])
@Index('ix_lbank_obs_event_batch', ['sourceBatchId'])
@Check('lbank_obs_event_star_count_range', 'star_count BETWEEN 1 AND 3')
@Check('lbank_obs_event_cmc_price_positive', 'cmc_price_usd > 0')
export class ObsEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  /** UTC calendar date of detected_at, `YYYY-MM-DD` (part of the key). */
  @Column({ name: 'detected_utc_date', type: 'date' })
  detectedUtcDate!: string;

  @Column({ name: 'star_count', type: 'integer' })
  starCount!: number;

  /** t0: the batch's crawl time (the scan's as-of time) of the first qualifying sighting. */
  @Column({ name: 'detected_at', type: 'timestamptz' })
  detectedAt!: Date;

  @Column({ name: 'source_updated_at', type: 'timestamptz' })
  sourceUpdatedAt!: Date;

  @Column({ name: 'source_batch_id', type: 'uuid' })
  sourceBatchId!: string;

  @ManyToOne(() => CrawlBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'source_batch_id' })
  sourceBatch?: Relation<CrawlBatch>;

  @Column({ name: 'slot_time', type: 'timestamptz' })
  slotTime!: Date;

  @BigintColumn({ name: 'snapshot_id', nullable: true })
  snapshotId!: number | null;

  @ManyToOne(() => MarketSnapshot, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'snapshot_id' })
  snapshot?: Relation<MarketSnapshot> | null;

  @Column({ name: 'intake_run_id', type: 'uuid', nullable: true })
  intakeRunId!: string | null;

  @ManyToOne(() => ObsIntakeRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'intake_run_id' })
  intakeRun?: Relation<ObsIntakeRun> | null;

  @Column({ name: 'is_live', type: 'boolean' })
  isLive!: boolean;

  /** CMC USD price of the qualifying scan: context only (never the LBank entry). */
  @DecimalColumn(38, 18, { name: 'cmc_price_usd' })
  cmcPriceUsd!: DValue;

  @Column({ type: 'text' })
  symbol!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  slug!: string | null;

  @Column({ type: 'integer', nullable: true })
  rank!: number | null;

  @Column({ name: 'platform_chain', type: 'text', nullable: true })
  platformChain!: string | null;

  @Column({ name: 'platform_address', type: 'text', nullable: true })
  platformAddress!: string | null;

  @DecimalColumn(38, 8, { name: 'cap_usd', nullable: true })
  capUsd!: DValue | null;

  @DecimalColumn(38, 8, { name: 'volume_24h_usd', nullable: true })
  volume24hUsd!: DValue | null;

  @DecimalColumn(65, 30, { name: 'current_vmc', nullable: true })
  currentVmc!: DValue | null;

  @DecimalColumn(65, 30, { name: 'vmc_3d_avg', nullable: true })
  vmc3dAvg!: DValue | null;

  @DecimalColumn(65, 30, { name: 'vmc_7d_avg', nullable: true })
  vmc7dAvg!: DValue | null;

  @DecimalColumn(65, 30, { name: 'vmc_14d_avg', nullable: true })
  vmc14dAvg!: DValue | null;

  @DecimalColumn(65, 30, { name: 'vmc_30d_avg', nullable: true })
  vmc30dAvg!: DValue | null;

  @DecimalColumn(65, 30, { name: 'multiple_3d', nullable: true })
  multiple3d!: DValue | null;

  @DecimalColumn(65, 30, { name: 'multiple_7d', nullable: true })
  multiple7d!: DValue | null;

  @DecimalColumn(65, 30, { name: 'multiple_30d', nullable: true })
  multiple30d!: DValue | null;

  @Column({ name: 'pass_3d', type: 'enum', enum: [...PASS_STATUSES], enumName: 'pass_status' })
  pass3d!: PassStatus;

  @Column({ name: 'pass_7d', type: 'enum', enum: [...PASS_STATUSES], enumName: 'pass_status' })
  pass7d!: PassStatus;

  @Column({ name: 'pass_30d', type: 'enum', enum: [...PASS_STATUSES], enumName: 'pass_status' })
  pass30d!: PassStatus;

  @Column({ name: 'queue_order', type: 'integer', nullable: true })
  queueOrder!: number | null;

  /** The weighted star ranking known at detection (points), never rewritten. */
  @Column({ name: 'weighted_pass_points', type: 'integer', nullable: true })
  weightedPassPoints!: number | null;

  @Column({ name: 'score_complete', type: 'boolean', nullable: true })
  scoreComplete!: boolean | null;

  @DecimalColumn(65, 30, { name: 'weighted_strength', nullable: true })
  weightedStrength!: DValue | null;

  @Column({ name: 'ranking_ruleset_version', type: 'text', nullable: true })
  rankingRulesetVersion!: string | null;

  /** The LBank Spot pairs the scanner resolved for this CMC id at detection (CMC's LBank list). */
  @Column({ name: 'lbank_pairs', type: 'jsonb' })
  lbankPairs!: ResolvedPair[];

  @Column({ name: 'ruleset_version', type: 'text' })
  rulesetVersion!: string;

  @Column({ name: 'config_version', type: 'text' })
  configVersion!: string;

  @Column({ name: 'inputs_hash', type: 'text' })
  inputsHash!: string;

  /** Every scanner field of the qualifying row as published. */
  @Column({ name: 'scan_snapshot', type: 'jsonb' })
  scanSnapshot!: Record<string, unknown>;

  @CreatedAtColumn()
  createdAt!: Date;
}

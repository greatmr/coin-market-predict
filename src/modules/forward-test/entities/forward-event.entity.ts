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
import {
  CreatedAtColumn,
  TextArrayColumn,
  UpdatedAtColumn,
} from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../../ingestion/entities/market-snapshot.entity.js';
import { PASS_STATUSES, type PassStatus, type ResolvedPair } from '../../strategy/index.js';
import { FORWARD_EVENT_STATUSES, type ForwardEventStatus } from '../forward.constants.js';

import { ForwardTestWatchlist } from './forward-test-watchlist.entity.js';
import { ForwardTriggerRun } from './forward-trigger-run.entity.js';

/**
 * One forward-test event: the first priced 1/2/3-star Review Queue observation per
 * (CMC id, UTC date, star count) (PDF p.4). The detection snapshot — price, times, batch, scanner
 * fields, window — is immutable (a database trigger refuses changes); only the tracking state
 * (status, quality flags, latest result version) changes. The unique key makes concurrent or
 * repeated triggers idempotent: the first insert wins.
 */
@Entity({ name: 'forward_event' })
@Unique('ux_forward_event_key', ['providerId', 'cmcId', 'detectedUtcDate', 'starCount'])
@Index('ix_forward_event_status', ['providerId', 'status'])
@Index('ix_forward_event_detected', ['providerId', 'detectedAt'])
@Index('ix_forward_event_batch', ['sourceBatchId'])
@Check('forward_event_star_count_range', 'star_count BETWEEN 1 AND 3')
@Check('forward_event_price_positive', 'snapshot_price_usd > 0')
export class ForwardEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @ManyToOne(() => ForwardTestWatchlist, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'provider_id', referencedColumnName: 'providerId' },
    { name: 'cmc_id', referencedColumnName: 'cmcId' },
  ])
  watchlist?: Relation<ForwardTestWatchlist>;

  /** UTC calendar date of detected_at, `YYYY-MM-DD` (part of the key; never a local date). */
  @Column({ name: 'detected_utc_date', type: 'date' })
  detectedUtcDate!: string;

  @Column({ name: 'star_count', type: 'integer' })
  starCount!: number;

  /** First qualifying scanner observation = the batch's crawl time (the scan's as-of time). */
  @Column({ name: 'detected_at', type: 'timestamptz' })
  detectedAt!: Date;

  /** Provider update time of the reference quote. */
  @Column({ name: 'source_updated_at', type: 'timestamptz' })
  sourceUpdatedAt!: Date;

  @Column({ name: 'source_batch_id', type: 'uuid' })
  sourceBatchId!: string;

  @ManyToOne(() => CrawlBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'source_batch_id' })
  sourceBatch?: Relation<CrawlBatch>;

  @Column({ name: 'slot_time', type: 'timestamptz' })
  slotTime!: Date;

  /** The crawler's stored observation (provenance; the values are copied below). */
  @BigintColumn({ name: 'snapshot_id', nullable: true })
  snapshotId!: number | null;

  @ManyToOne(() => MarketSnapshot, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'snapshot_id' })
  snapshot?: Relation<MarketSnapshot> | null;

  @Column({ name: 'trigger_run_id', type: 'uuid', nullable: true })
  triggerRunId!: string | null;

  @ManyToOne(() => ForwardTriggerRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'trigger_run_id' })
  triggerRun?: Relation<ForwardTriggerRun> | null;

  @Column({ name: 'is_live', type: 'boolean' })
  isLive!: boolean;

  /** The CMC USD price of the qualifying scan: a paper reference, never a fill. Full precision. */
  @DecimalColumn(38, 18, { name: 'snapshot_price_usd' })
  snapshotPriceUsd!: DValue;

  @Column({ name: 'quote_currency', type: 'text', default: 'USD' })
  quoteCurrency!: string;

  @Column({ type: 'text' })
  symbol!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  slug!: string | null;

  @Column({ type: 'integer', nullable: true })
  rank!: number | null;

  /** Contract / network evidence at detection (CMC platform). */
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

  /**
   * Ranking fields known at detection (weighted star ranking, addendum § 5), part of the immutable
   * snapshot: a later score on the same key never overwrites them. NULL for events detected before
   * the ranking existed; never back-filled.
   */
  @Column({ name: 'weighted_pass_points', type: 'integer', nullable: true })
  weightedPassPoints!: number | null;

  @Column({ name: 'score_complete', type: 'boolean', nullable: true })
  scoreComplete!: boolean | null;

  @DecimalColumn(65, 30, { name: 'weighted_strength', nullable: true })
  weightedStrength!: DValue | null;

  @Column({ name: 'ranking_ruleset_version', type: 'text', nullable: true })
  rankingRulesetVersion!: string | null;

  @Column({ name: 'lbank_pairs', type: 'jsonb' })
  lbankPairs!: ResolvedPair[];

  /** Tier 1 ruleset and configuration that produced the stars (never recalculated here). */
  @Column({ name: 'ruleset_version', type: 'text' })
  rulesetVersion!: string;

  @Column({ name: 'config_version', type: 'text' })
  configVersion!: string;

  @Column({ name: 'inputs_hash', type: 'text' })
  inputsHash!: string;

  /** Every scanner field of the qualifying row as it was published (scan rows are replaced on reprocessing). */
  @Column({ name: 'scan_snapshot', type: 'jsonb' })
  scanSnapshot!: Record<string, unknown>;

  @Column({ name: 'deadline_168h', type: 'timestamptz' })
  deadline168h!: Date;

  @Column({ name: 'evaluation_end', type: 'timestamptz' })
  evaluationEnd!: Date;

  @DecimalColumn(65, 30, { name: 'effective_horizon_hours' })
  effectiveHorizonHours!: DValue;

  /** Forward-test rules version at detection. */
  @Column({ name: 'rules_version', type: 'text' })
  rulesVersion!: string;

  // ── Tracking state (the only columns that change) ───────────────────────────────────────

  @Column({
    type: 'enum',
    enum: [...FORWARD_EVENT_STATUSES],
    enumName: 'forward_event_status',
  })
  status!: ForwardEventStatus;

  /** Reason codes of the latest outcome plus identity flags. */
  @TextArrayColumn('quality_flags')
  qualityFlags!: string[];

  /** Latest `forward_outcome.result_version` (0 = no outcome yet). */
  @Column({ name: 'result_version', type: 'integer', default: 0 })
  resultVersion!: number;

  @Column({ name: 'last_update_at', type: 'timestamptz', nullable: true })
  lastUpdateAt!: Date | null;

  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

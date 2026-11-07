import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  type Relation,
  Unique,
} from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';
import { TextArrayColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { Provider } from '../../sources/entities/provider.entity.js';
import {
  CURRENT_STATUSES,
  type CurrentStatus,
  ELIGIBILITY_STATUSES,
  type EligibilityStatus,
  LBANK_STATUSES,
  type LbankStatus,
  PASS_STATUSES,
  type PassStatus,
  type ResolvedPair,
  TIER1_CLASSES,
  type Tier1Class,
  VENUE_DECISIONS,
  type VenueReview,
} from '../../strategy/index.js';

import { ScanRun } from './scan-run.entity.js';

/**
 * One Tier 1 result per (crawl batch, CMC id) (PDF p.12, p.16, p.17). Raw inputs and source
 * timestamps sit beside every computed value; N/A values are NULL with a reason code.
 */
@Entity({ name: 'scan_result' })
@Unique('ux_scan_result_asset', ['batchId', 'cmcId'])
@Index('ix_scan_result_eligibility', ['batchId', 'eligibilityStatus'])
@Index('ix_scan_result_queue', ['batchId', 'inQueue'])
@Index('ix_scan_result_asset_history', ['providerId', 'cmcId', 'crawledAt'])
@Check('scan_result_stars_range', 'stars BETWEEN 0 AND 3')
export class ScanResult extends HasBigintId {
  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => ScanRun, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id', referencedColumnName: 'batchId' })
  scanRun?: Relation<ScanRun>;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @Column({ type: 'text' })
  symbol!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  slug!: string | null;

  @Column({ type: 'integer', nullable: true })
  rank!: number | null;

  @Column({ name: 'date_added', type: 'timestamptz', nullable: true })
  dateAdded!: Date | null;

  @DecimalColumn(14, 6, { name: 'age_days', nullable: true })
  ageDays!: DValue | null;

  @DecimalColumn(38, 18, { name: 'price_usd', nullable: true })
  priceUsd!: DValue | null;

  @DecimalColumn(38, 8, { name: 'cap_usd', nullable: true })
  capUsd!: DValue | null;

  @DecimalColumn(38, 8, { name: 'volume_24h_usd', nullable: true })
  volume24hUsd!: DValue | null;

  /** Provider update time of the current quote. */
  @Column({ name: 'observed_at', type: 'timestamptz', nullable: true })
  observedAt!: Date | null;

  /** Crawl time of the current quote. */
  @Column({ name: 'crawled_at', type: 'timestamptz' })
  crawledAt!: Date;

  @Column({
    name: 'current_status',
    type: 'enum',
    enum: [...CURRENT_STATUSES],
    enumName: 'current_status',
  })
  currentStatus!: CurrentStatus;

  @Column({ name: 'current_reason', type: 'text', nullable: true })
  currentReason!: string | null;

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

  @Column({ name: 'avg_3d_reason', type: 'text', nullable: true })
  avg3dReason!: string | null;

  @Column({ name: 'avg_7d_reason', type: 'text', nullable: true })
  avg7dReason!: string | null;

  @Column({ name: 'avg_14d_reason', type: 'text', nullable: true })
  avg14dReason!: string | null;

  @Column({ name: 'avg_30d_reason', type: 'text', nullable: true })
  avg30dReason!: string | null;

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

  @Column({ name: 'reason_3d', type: 'text', nullable: true })
  reason3d!: string | null;

  @Column({ name: 'reason_7d', type: 'text', nullable: true })
  reason7d!: string | null;

  @Column({ name: 'reason_30d', type: 'text', nullable: true })
  reason30d!: string | null;

  @Column({ type: 'integer' })
  stars!: number;

  @Column({
    name: 'eligibility_status',
    type: 'enum',
    enum: [...ELIGIBILITY_STATUSES],
    enumName: 'eligibility_status',
  })
  eligibilityStatus!: EligibilityStatus;

  @TextArrayColumn('eligibility_reasons')
  eligibilityReasons!: string[];

  @Column({ name: 'asset_class', type: 'enum', enum: [...TIER1_CLASSES], enumName: 'tier1_class' })
  assetClass!: Tier1Class;

  @Column({ name: 'class_source', type: 'text', nullable: true })
  classSource!: string | null;

  @Column({
    name: 'lbank_status',
    type: 'enum',
    enum: [...LBANK_STATUSES],
    enumName: 'lbank_status',
  })
  lbankStatus!: LbankStatus;

  @Column({ name: 'lbank_reason', type: 'text', nullable: true })
  lbankReason!: string | null;

  @Column({ name: 'lbank_pairs', type: 'jsonb' })
  lbankPairs!: ResolvedPair[];

  /** PENDING until a reviewer decides (reviews hold ACCEPT / REJECT). */
  @Column({
    name: 'venue_review',
    type: 'enum',
    enum: [...VENUE_DECISIONS],
    enumName: 'venue_review',
  })
  venueReview!: VenueReview;

  @TextArrayColumn('venue_flags')
  venueFlags!: string[];

  @TextArrayColumn('flags')
  flags!: string[];

  @Column({ name: 'in_queue', type: 'boolean', default: false })
  inQueue!: boolean;

  @Column({ name: 'queue_order', type: 'integer', nullable: true })
  queueOrder!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  diagnostics!: Record<string, unknown> | null;

  /** Dates, values and daily revision ids used (lineage). */
  @Column({ name: 'daily_window', type: 'jsonb', nullable: true })
  dailyWindow!: {
    asOfDate: string;
    dates: string[];
    revisionIds: Array<number | null>;
    missingDates: string[];
    invalidDates: string[];
  } | null;

  @Column({ name: 'inputs_hash', type: 'text' })
  inputsHash!: string;

  @Column({ name: 'ruleset_version', type: 'text' })
  rulesetVersion!: string;

  @Column({ name: 'config_version', type: 'text' })
  configVersion!: string;

  /** Scan (processing) time. */
  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt!: Date;
}

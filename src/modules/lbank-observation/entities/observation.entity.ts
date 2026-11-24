import {
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

import { Provider } from '../../sources/entities/provider.entity.js';
import {
  ELIGIBILITY_CLASSES,
  EXTREME_ORDERS,
  type EligibilityClass,
  type ExtremeOrder,
  LISTING_STATUSES,
  type ListingStatus,
  MAPPING_STATUSES,
  type MappingStatus,
  OBSERVATION_STATUSES,
  type ObservationStatus,
} from '../observation.constants.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { MarketListFetch } from './market-list-fetch.entity.js';
import { ObsEvent } from './obs-event.entity.js';
import { SpotPair } from './spot-pair.entity.js';

/**
 * The LBank Spot price observation of one CMC star event (docs/lbank-spot-observation.md): its
 * LBank Spot pair and the evidence for it, Spot / Futures eligibility at the signal, the entry
 * reference, the two extremes and coverage over exactly t0 … t0 + 168 h. One per event
 * (`event_id` is a unique foreign key). Updated while ACTIVE; frozen once `finalized_at` is set,
 * when its terminal result is also written to `lbank_observation_result`.
 */
@Entity({ name: 'lbank_observation' })
@Unique('ux_lbank_observation_event', ['eventId'])
@Index('ix_lbank_observation_status', ['providerId', 'status'])
@Index('ix_lbank_observation_t0', ['providerId', 't0'])
@Index('ix_lbank_observation_pair', ['pairId'])
export class Observation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => ObsEvent, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event?: Relation<ObsEvent>;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'is_live', type: 'boolean' })
  isLive!: boolean;

  /** The event's immutable CMC signal time. */
  @Column({ type: 'timestamptz' })
  t0!: Date;

  /** Exactly t0 + 168 h. */
  @Column({ name: 'window_end', type: 'timestamptz' })
  windowEnd!: Date;

  // ── LBank Spot pair ──────────────────────────────────────────────────────────────────────
  @Column({ name: 'pair_id', type: 'integer', nullable: true })
  pairId!: number | null;

  @ManyToOne(() => SpotPair, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pair_id' })
  pair?: Relation<SpotPair> | null;

  @Column({ name: 'pair_symbol', type: 'text', nullable: true })
  pairSymbol!: string | null;

  @Column({ name: 'quote_asset', type: 'text', nullable: true })
  quoteAsset!: string | null;

  @Column({
    name: 'mapping_status',
    type: 'enum',
    enum: [...MAPPING_STATUSES],
    enumName: 'lbank_obs_mapping_status',
  })
  mappingStatus!: MappingStatus;

  @Column({ name: 'mapping_evidence', type: 'jsonb' })
  mappingEvidence!: Record<string, unknown>;

  // ── Eligibility at the signal ────────────────────────────────────────────────────────────
  @Column({
    name: 'spot_status',
    type: 'enum',
    enum: [...LISTING_STATUSES],
    enumName: 'lbank_obs_listing_status',
  })
  spotStatus!: ListingStatus;

  /** TRADES_OBSERVED / NO_RECENT_TRADES / UNKNOWN: a trade within an hour of the signal. */
  @Column({ name: 'spot_trading', type: 'text', nullable: true })
  spotTrading!: string | null;

  @Column({
    name: 'futures_status',
    type: 'enum',
    enum: [...LISTING_STATUSES],
    enumName: 'lbank_obs_listing_status',
  })
  futuresStatus!: ListingStatus;

  @Column({
    type: 'enum',
    enum: [...ELIGIBILITY_CLASSES],
    enumName: 'lbank_obs_eligibility',
  })
  eligibility!: EligibilityClass;

  @Column({ name: 'eligibility_evidence', type: 'jsonb' })
  eligibilityEvidence!: Record<string, unknown>;

  @Column({ name: 'eligibility_checked_at', type: 'timestamptz', nullable: true })
  eligibilityCheckedAt!: Date | null;

  @BigintColumn({ name: 'spot_list_fetch_id', nullable: true })
  spotListFetchId!: number | null;

  @ManyToOne(() => MarketListFetch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'spot_list_fetch_id' })
  spotListFetch?: Relation<MarketListFetch> | null;

  @BigintColumn({ name: 'futures_list_fetch_id', nullable: true })
  futuresListFetchId!: number | null;

  @ManyToOne(() => MarketListFetch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'futures_list_fetch_id' })
  futuresListFetch?: Relation<MarketListFetch> | null;

  // ── Entry reference ──────────────────────────────────────────────────────────────────────
  /** Open time of the entry bar (the first 1-minute bar opening at or after t0). */
  @Column({ name: 'entry_at', type: 'timestamptz', nullable: true })
  entryAt!: Date | null;

  /** The entry bar's OPEN (LBank's last traded price at that instant). */
  @ExactNumericColumn({ name: 'entry_price', nullable: true })
  entryPrice!: DValue | null;

  @Column({ name: 'entry_delay_ms', type: 'integer', nullable: true })
  entryDelayMs!: number | null;

  /** Open time of the last bar with trades before the entry bar (within the look-back). */
  @Column({ name: 'entry_last_trade_at', type: 'timestamptz', nullable: true })
  entryLastTradeAt!: Date | null;

  @Column({ name: 'entry_stale', type: 'boolean', nullable: true })
  entryStale!: boolean | null;

  // ── Extremes (LBank Spot only) ───────────────────────────────────────────────────────────
  @ExactNumericColumn({ name: 'high_price', nullable: true })
  highPrice!: DValue | null;

  @Column({ name: 'high_bar_at', type: 'timestamptz', nullable: true })
  highBarAt!: Date | null;

  @ExactNumericColumn({ name: 'low_price', nullable: true })
  lowPrice!: DValue | null;

  @Column({ name: 'low_bar_at', type: 'timestamptz', nullable: true })
  lowBarAt!: Date | null;

  @DecimalColumn(65, 30, { name: 'max_rise_pct', nullable: true })
  maxRisePct!: DValue | null;

  @DecimalColumn(65, 30, { name: 'max_drop_pct', nullable: true })
  maxDropPct!: DValue | null;

  @ExactNumericColumn({ name: 'low_before_high_price', nullable: true })
  lowBeforeHighPrice!: DValue | null;

  @Column({ name: 'low_before_high_bar_at', type: 'timestamptz', nullable: true })
  lowBeforeHighBarAt!: Date | null;

  @Column({
    name: 'extreme_order',
    type: 'enum',
    enum: [...EXTREME_ORDERS],
    enumName: 'lbank_obs_extreme_order',
    nullable: true,
  })
  extremeOrder!: ExtremeOrder | null;

  // ── Coverage ─────────────────────────────────────────────────────────────────────────────
  @Column({ name: 'expected_bars', type: 'integer' })
  expectedBars!: number;

  @Column({ name: 'observed_through', type: 'timestamptz', nullable: true })
  observedThrough!: Date | null;

  @Column({ name: 'covered_bars', type: 'integer', default: 0 })
  coveredBars!: number;

  @Column({ name: 'traded_bars', type: 'integer', default: 0 })
  tradedBars!: number;

  @Column({ name: 'missing_bars', type: 'integer', default: 0 })
  missingBars!: number;

  /** `[[fromIso, toIso), …]` of minutes the API answered without a bar. */
  @Column({ name: 'missing_ranges', type: 'jsonb' })
  missingRanges!: Array<[string, string]>;

  @Column({ name: 'start_unobserved_ms', type: 'integer' })
  startUnobservedMs!: number;

  @Column({ name: 'boundary_unobserved_ms', type: 'integer' })
  boundaryUnobservedMs!: number;

  // ── State ────────────────────────────────────────────────────────────────────────────────
  @Column({
    type: 'enum',
    enum: [...OBSERVATION_STATUSES],
    enumName: 'lbank_obs_status',
  })
  status!: ObservationStatus;

  @TextArrayColumn('reasons')
  reasons!: string[];

  @Column({ name: 'rules_version', type: 'text' })
  rulesVersion!: string;

  @Column({ name: 'result_version', type: 'integer', default: 0 })
  resultVersion!: number;

  /** SHA-256 of the canonical bars the extremes were computed from. */
  @Column({ name: 'series_sha256', type: 'text', nullable: true })
  seriesSha256!: string | null;

  /** The last successful computation. */
  @Column({ name: 'last_update_at', type: 'timestamptz', nullable: true })
  lastUpdateAt!: Date | null;

  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

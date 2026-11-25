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

import { Provider } from '../../sources/entities/provider.entity.js';
import {
  ELIGIBILITY_CLASSES,
  EXTREMES_ORDERS,
  EXTREME_ORDERS,
  type EligibilityClass,
  type ExtremeOrder,
  type ExtremesOrder,
  LISTING_STATUSES,
  type ListingStatus,
  MAPPING_STATUSES,
  type MappingStatus,
  OBSERVATION_STATUSES,
  type ObservationStatus,
  REFERENCE_STATUSES,
  type ReferenceStatus,
  TIMING_SOURCES,
  type TimingSource,
} from '../observation.constants.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { MarketListFetch } from './market-list-fetch.entity.js';
import { ObsEvent } from './obs-event.entity.js';
import { SpotPair } from './spot-pair.entity.js';

/**
 * The LBank Spot price observation of one CMC star event (docs/lbank-spot-observation.md): its
 * LBank Spot pair and the evidence for it, Spot / Futures evidence at the signal, and (rules v2) the
 * proven actionable start, the reference trade, the trade-verified extremes, coverage, gaps and data
 * freshness over exactly [observation_start, observation_start + 168 h). One per event (`event_id`
 * is a unique foreign key). Updated while ACTIVE; frozen once `finalized_at` is set, when its
 * terminal result is also written to `lbank_observation_result`. The rules-v1 columns (entry, High /
 * Low bars, coverage in bars, `window_end`) are an audit record of the first rules and never change
 * once a row has left v1 (migration M016 trigger).
 */
@Entity({ name: 'lbank_observation' })
@Unique('ux_lbank_observation_event', ['eventId'])
@Index('ix_lbank_observation_status', ['providerId', 'status'])
@Index('ix_lbank_observation_t0', ['providerId', 't0'])
@Index('ix_lbank_observation_pair', ['pairId'])
@Index('ix_lbank_observation_start', ['providerId', 'observationStart'])
@Check(
  'lbank_observation_window_exact',
  `observation_start IS NULL OR observation_end = observation_start + interval '168 hours'`,
)
@Check(
  'lbank_observation_start_after_crawl',
  'observation_start IS NULL OR observation_start >= t0',
)
@Check(
  'lbank_observation_returns_signed',
  '(highest_return_pct IS NULL OR highest_return_pct >= 0) AND (lowest_return_pct IS NULL OR lowest_return_pct <= 0)',
)
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

  /** The event's immutable CMC crawl time (t0): identity, UTC date and routing only. */
  @Column({ type: 'timestamptz' })
  t0!: Date;

  /** Rules v1 audit: t0 + 168 h. The v2 window is [observation_start, observation_end). */
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

  // ── Rules v1 audit (candle-OPEN entry from the crawl time; never drives a v2 value) ─────────
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

  @Column({ name: 'expected_bars', type: 'integer', nullable: true })
  expectedBars!: number | null;

  @Column({ name: 'observed_through', type: 'timestamptz', nullable: true })
  observedThrough!: Date | null;

  @Column({ name: 'covered_bars', type: 'integer', nullable: true })
  coveredBars!: number | null;

  @Column({ name: 'traded_bars', type: 'integer', nullable: true })
  tradedBars!: number | null;

  @Column({ name: 'missing_bars', type: 'integer', nullable: true })
  missingBars!: number | null;

  /** `[[fromIso, toIso), …]` of minutes the API answered without a bar. */
  @Column({ name: 'missing_ranges', type: 'jsonb', nullable: true })
  missingRanges!: Array<[string, string]> | null;

  @Column({ name: 'start_unobserved_ms', type: 'integer', nullable: true })
  startUnobservedMs!: number | null;

  @Column({ name: 'boundary_unobserved_ms', type: 'integer', nullable: true })
  boundaryUnobservedMs!: number | null;

  /** SHA-256 of the canonical bars the v1 extremes were computed from. */
  @Column({ name: 'series_sha256', type: 'text', nullable: true })
  seriesSha256!: string | null;

  // ── Rules v2: actionable start ───────────────────────────────────────────────────────────
  /** The earliest proven moment the star signal was usable (never the crawl time). */
  @Column({ name: 'actionable_at', type: 'timestamptz', nullable: true })
  actionableAt!: Date | null;

  @Column({
    name: 'actionable_source',
    type: 'enum',
    enum: [...TIMING_SOURCES],
    enumName: 'lbank_obs_timing_source',
    nullable: true,
  })
  actionableSource!: TimingSource | null;

  @Column({ name: 'actionable_evidence', type: 'jsonb', default: () => "'{}'" })
  actionableEvidence!: Record<string, unknown>;

  @Column({ name: 'observation_start', type: 'timestamptz', nullable: true })
  observationStart!: Date | null;

  /** Exactly observation_start + 168 h (exclusive end). */
  @Column({ name: 'observation_end', type: 'timestamptz', nullable: true })
  observationEnd!: Date | null;

  // ── Rules v2: reference (the first verified trade at or after the start) ──────────────────
  @Column({
    name: 'reference_status',
    type: 'enum',
    enum: [...REFERENCE_STATUSES],
    enumName: 'lbank_obs_reference_status',
    default: 'PENDING',
  })
  referenceStatus!: ReferenceStatus;

  @Column({ name: 'reference_trade_id', type: 'text', nullable: true })
  referenceTradeId!: string | null;

  @Column({ name: 'reference_at', type: 'timestamptz', nullable: true })
  referenceAt!: Date | null;

  @ExactNumericColumn({ name: 'reference_price', nullable: true })
  referencePrice!: DValue | null;

  @ExactNumericColumn({ name: 'reference_qty', nullable: true })
  referenceQty!: DValue | null;

  /** reference_at − observation_start (ms). */
  @Column({ name: 'reference_delay_ms', type: 'integer', nullable: true })
  referenceDelayMs!: number | null;

  /** At least one whole minute after the start was verified silent before the reference trade. */
  @Column({ name: 'reference_delayed', type: 'boolean', nullable: true })
  referenceDelayed!: boolean | null;

  @Column({ name: 'reference_evidence', type: 'jsonb', default: () => "'{}'" })
  referenceEvidence!: Record<string, unknown>;

  // ── Rules v2: extremes (verified LBank Spot trades only) ─────────────────────────────────
  @ExactNumericColumn({ name: 'highest_price', nullable: true })
  highestPrice!: DValue | null;

  @Column({ name: 'highest_at', type: 'timestamptz', nullable: true })
  highestAt!: Date | null;

  @Column({ name: 'highest_trade_id', type: 'text', nullable: true })
  highestTradeId!: string | null;

  /** 100 × (highest / reference − 1) ≥ 0. Not profit. */
  @DecimalColumn(65, 30, { name: 'highest_return_pct', nullable: true })
  highestReturnPct!: DValue | null;

  @ExactNumericColumn({ name: 'lowest_price', nullable: true })
  lowestPrice!: DValue | null;

  @Column({ name: 'lowest_at', type: 'timestamptz', nullable: true })
  lowestAt!: Date | null;

  @Column({ name: 'lowest_trade_id', type: 'text', nullable: true })
  lowestTradeId!: string | null;

  /** 100 × (lowest / reference − 1) ≤ 0. Not a stop loss. */
  @DecimalColumn(65, 30, { name: 'lowest_return_pct', nullable: true })
  lowestReturnPct!: DValue | null;

  @ExactNumericColumn({ name: 'low_before_highest_price', nullable: true })
  lowBeforeHighestPrice!: DValue | null;

  @Column({ name: 'low_before_highest_at', type: 'timestamptz', nullable: true })
  lowBeforeHighestAt!: Date | null;

  @Column({ name: 'low_before_highest_trade_id', type: 'text', nullable: true })
  lowBeforeHighestTradeId!: string | null;

  @Column({
    name: 'extremes_order',
    type: 'enum',
    enum: [...EXTREMES_ORDERS],
    enumName: 'lbank_obs_extremes_order',
    nullable: true,
  })
  extremesOrder!: ExtremesOrder | null;

  /** Every minute that could hold a more extreme price was checked (or ruled out by its candle). */
  @Column({ name: 'extremes_proven', type: 'boolean', default: false })
  extremesProven!: boolean;

  @Column({ name: 'extremes_evidence', type: 'jsonb', default: () => "'{}'" })
  extremesEvidence!: Record<string, unknown>;

  @TextArrayColumn('flags')
  flags!: string[];

  @Column({ name: 'flags_evidence', type: 'jsonb', default: () => "'{}'" })
  flagsEvidence!: Record<string, unknown>;

  // ── Rules v2: coverage, gaps and data freshness ──────────────────────────────────────────
  @Column({ name: 'minutes_expected', type: 'integer', nullable: true })
  minutesExpected!: number | null;

  @Column({ name: 'minutes_present', type: 'integer', default: 0 })
  minutesPresent!: number;

  @Column({ name: 'minutes_traded', type: 'integer', default: 0 })
  minutesTraded!: number;

  @Column({ name: 'minutes_missing', type: 'integer', default: 0 })
  minutesMissing!: number;

  /** `[{ from, to, state, detail? }]` (GAP_STATES), oldest first. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  gaps!: Array<{ from: string; to: string; state: string; detail?: string }>;

  /** Exclusive end of the window part the candles were fetched through (data freshness). */
  @Column({ name: 'data_through', type: 'timestamptz', nullable: true })
  dataThrough!: Date | null;

  /** The pair's last successful LBank fetch (candles or trades). */
  @Column({ name: 'last_source_fetch_at', type: 'timestamptz', nullable: true })
  lastSourceFetchAt!: Date | null;

  @Column({ name: 'last_fetch_attempt_at', type: 'timestamptz', nullable: true })
  lastFetchAttemptAt!: Date | null;

  @Column({ name: 'last_fetch_error', type: 'text', nullable: true })
  lastFetchError!: string | null;

  /** Gaps are retried until this (observation_end + 24 h), then the status is terminal. */
  @Column({ name: 'retry_until', type: 'timestamptz', nullable: true })
  retryUntil!: Date | null;

  /** SHA-256 of the candles and trades the terminal result rests on. */
  @Column({ name: 'evidence_sha256', type: 'text', nullable: true })
  evidenceSha256!: string | null;

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

  /** The last recomputation (not data freshness: see data_through / last_source_fetch_at). */
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

import { Column, Entity, JoinColumn, ManyToOne, type Relation, Unique } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';
import { TextArrayColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import {
  ELIGIBILITY_CLASSES,
  EXTREMES_ORDERS,
  EXTREME_ORDERS,
  type EligibilityClass,
  type ExtremeOrder,
  type ExtremesOrder,
  OBSERVATION_STATUSES,
  type ObservationStatus,
  REFERENCE_STATUSES,
  type ReferenceStatus,
  TIMING_SOURCES,
  type TimingSource,
} from '../observation.constants.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { Observation } from './observation.entity.js';

/**
 * The terminal result of an observation as computed, one row per result version and rules version
 * (`rules_version`): v1 rows carry the candle-OPEN entry and bar extremes, v2 rows (since M016) the
 * actionable start, the reference trade and the trade-verified extremes. Append-only: a database
 * trigger refuses updates and deletes, so a recalculation under new rules adds a version.
 */
@Entity({ name: 'lbank_observation_result' })
@Unique('ux_lbank_observation_result_version', ['observationId', 'resultVersion'])
export class ObservationResult extends HasBigintId {
  @Column({ name: 'observation_id', type: 'uuid' })
  observationId!: string;

  @ManyToOne(() => Observation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'observation_id' })
  observation?: Relation<Observation>;

  @Column({ name: 'result_version', type: 'integer' })
  resultVersion!: number;

  @Column({ type: 'enum', enum: [...OBSERVATION_STATUSES], enumName: 'lbank_obs_status' })
  status!: ObservationStatus;

  @Column({ type: 'enum', enum: [...ELIGIBILITY_CLASSES], enumName: 'lbank_obs_eligibility' })
  eligibility!: EligibilityClass;

  @TextArrayColumn('reasons')
  reasons!: string[];

  @Column({ name: 'rules_version', type: 'text' })
  rulesVersion!: string;

  @Column({ name: 'entry_at', type: 'timestamptz', nullable: true })
  entryAt!: Date | null;

  @ExactNumericColumn({ name: 'entry_price', nullable: true })
  entryPrice!: DValue | null;

  @Column({ name: 'entry_delay_ms', type: 'integer', nullable: true })
  entryDelayMs!: number | null;

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

  @Column({ name: 'covered_bars', type: 'integer', nullable: true })
  coveredBars!: number | null;

  @Column({ name: 'traded_bars', type: 'integer', nullable: true })
  tradedBars!: number | null;

  @Column({ name: 'missing_bars', type: 'integer', nullable: true })
  missingBars!: number | null;

  @Column({ name: 'missing_ranges', type: 'jsonb', nullable: true })
  missingRanges!: Array<[string, string]> | null;

  @Column({ name: 'series_sha256', type: 'text', nullable: true })
  seriesSha256!: string | null;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt!: Date;

  // ── Rules v2 ─────────────────────────────────────────────────────────────────────────────
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

  @Column({ name: 'observation_start', type: 'timestamptz', nullable: true })
  observationStart!: Date | null;

  @Column({ name: 'observation_end', type: 'timestamptz', nullable: true })
  observationEnd!: Date | null;

  @Column({
    name: 'reference_status',
    type: 'enum',
    enum: [...REFERENCE_STATUSES],
    enumName: 'lbank_obs_reference_status',
    nullable: true,
  })
  referenceStatus!: ReferenceStatus | null;

  @Column({ name: 'reference_trade_id', type: 'text', nullable: true })
  referenceTradeId!: string | null;

  @Column({ name: 'reference_at', type: 'timestamptz', nullable: true })
  referenceAt!: Date | null;

  @ExactNumericColumn({ name: 'reference_price', nullable: true })
  referencePrice!: DValue | null;

  @Column({ name: 'reference_delay_ms', type: 'integer', nullable: true })
  referenceDelayMs!: number | null;

  @ExactNumericColumn({ name: 'highest_price', nullable: true })
  highestPrice!: DValue | null;

  @Column({ name: 'highest_at', type: 'timestamptz', nullable: true })
  highestAt!: Date | null;

  @Column({ name: 'highest_trade_id', type: 'text', nullable: true })
  highestTradeId!: string | null;

  @DecimalColumn(65, 30, { name: 'highest_return_pct', nullable: true })
  highestReturnPct!: DValue | null;

  @ExactNumericColumn({ name: 'lowest_price', nullable: true })
  lowestPrice!: DValue | null;

  @Column({ name: 'lowest_at', type: 'timestamptz', nullable: true })
  lowestAt!: Date | null;

  @Column({ name: 'lowest_trade_id', type: 'text', nullable: true })
  lowestTradeId!: string | null;

  @DecimalColumn(65, 30, { name: 'lowest_return_pct', nullable: true })
  lowestReturnPct!: DValue | null;

  @ExactNumericColumn({ name: 'low_before_highest_price', nullable: true })
  lowBeforeHighestPrice!: DValue | null;

  @Column({ name: 'low_before_highest_at', type: 'timestamptz', nullable: true })
  lowBeforeHighestAt!: Date | null;

  @Column({
    name: 'extremes_order',
    type: 'enum',
    enum: [...EXTREMES_ORDERS],
    enumName: 'lbank_obs_extremes_order',
    nullable: true,
  })
  extremesOrder!: ExtremesOrder | null;

  @TextArrayColumn('flags')
  flags!: string[];

  @Column({ type: 'jsonb', nullable: true })
  gaps!: Array<{ from: string; to: string; state: string; detail?: string }> | null;

  @Column({ name: 'minutes_expected', type: 'integer', nullable: true })
  minutesExpected!: number | null;

  @Column({ name: 'minutes_present', type: 'integer', nullable: true })
  minutesPresent!: number | null;

  @Column({ name: 'minutes_traded', type: 'integer', nullable: true })
  minutesTraded!: number | null;

  @Column({ name: 'minutes_missing', type: 'integer', nullable: true })
  minutesMissing!: number | null;

  @Column({ name: 'evidence_sha256', type: 'text', nullable: true })
  evidenceSha256!: string | null;

  /** The full v2 computation (reference, extremes, gaps, flags evidence) as frozen. */
  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;
}

import { Column, Entity, JoinColumn, ManyToOne, type Relation, Unique } from 'typeorm';

import { BigintColumn, HasBigintId } from '../../../common/entities/bigint.js';
import { TextArrayColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { DAY0_STATES, type Day0State } from '../forward-rules.js';
import {
  COVERAGE_STATUSES,
  type CoverageStatus,
  EXTENSION_FLAGS,
  type ExtensionFlag,
  FORWARD_EVENT_STATUSES,
  type ForwardEventStatus,
  PEAK_KINDS,
  type PeakKind,
  TIME_PRECISIONS,
  type TimePrecision,
} from '../forward.constants.js';

import { ForwardEvent } from './forward-event.entity.js';
import { ForwardHigh } from './forward-high.entity.js';
import { ForwardUpdateRun } from './forward-update-run.entity.js';

/**
 * A derived result of one event (PDF p.8), versioned and append-only: a daily update or a late
 * source revision that changes the result adds the next `result_version`; earlier versions stay.
 * Provisional results (window open, final day pending, coverage incomplete) are lower bounds and
 * say so in `peak_kind`; only FINAL / EXACT results enter the primary star-group aggregates.
 * This is the maximum hypothetical upside from the detection price — not a fill, not realized P/L.
 */
@Entity({ name: 'forward_outcome' })
@Unique('ux_forward_outcome_version', ['eventId', 'resultVersion'])
export class ForwardOutcome extends HasBigintId {
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => ForwardEvent, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event?: Relation<ForwardEvent>;

  @Column({ name: 'result_version', type: 'integer' })
  resultVersion!: number;

  /** first | daily_update | source_revision */
  @Column({ name: 'revision_reason', type: 'text' })
  revisionReason!: string;

  @Column({ name: 'rules_version', type: 'text' })
  rulesVersion!: string;

  @Column({ type: 'enum', enum: [...FORWARD_EVENT_STATUSES], enumName: 'forward_event_status' })
  status!: ForwardEventStatus;

  @Column({
    name: 'coverage_status',
    type: 'enum',
    enum: [...COVERAGE_STATUSES],
    enumName: 'forward_coverage_status',
  })
  coverageStatus!: CoverageStatus;

  @Column({ name: 'peak_kind', type: 'enum', enum: [...PEAK_KINDS], enumName: 'forward_peak_kind' })
  peakKind!: PeakKind;

  @DecimalColumn(38, 18, { name: 'peak_high_usd', nullable: true })
  peakHighUsd!: DValue | null;

  @BigintColumn({ name: 'peak_high_id', nullable: true })
  peakHighId!: number | null;

  @ManyToOne(() => ForwardHigh, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'peak_high_id' })
  peakHigh?: Relation<ForwardHigh> | null;

  @Column({ name: 'peak_date', type: 'date', nullable: true })
  peakDate!: string | null;

  @Column({ name: 'peak_at', type: 'timestamptz', nullable: true })
  peakAt!: Date | null;

  @Column({
    name: 'peak_time_precision',
    type: 'enum',
    enum: [...TIME_PRECISIONS],
    enumName: 'forward_time_precision',
    nullable: true,
  })
  peakTimePrecision!: TimePrecision | null;

  @Column({ name: 'peak_period_start', type: 'timestamptz', nullable: true })
  peakPeriodStart!: Date | null;

  @Column({ name: 'peak_period_end', type: 'timestamptz', nullable: true })
  peakPeriodEnd!: Date | null;

  /** 100 × (peak_high_usd / snapshot_price_usd − 1), unrounded (rounded half-even to 30 dp for storage). */
  @DecimalColumn(65, 30, { name: 'peak_return_pct', nullable: true })
  peakReturnPct!: DValue | null;

  @Column({
    name: 'extension_peak_flag',
    type: 'enum',
    enum: [...EXTENSION_FLAGS],
    enumName: 'forward_extension_flag',
    nullable: true,
  })
  extensionPeakFlag!: ExtensionFlag | null;

  @DecimalColumn(65, 30, { name: 'effective_horizon_hours' })
  effectiveHorizonHours!: DValue;

  @Column({
    name: 'day0_state',
    type: 'enum',
    enum: [...DAY0_STATES],
    enumName: 'forward_day0_state',
  })
  day0State!: Day0State;

  @Column({ name: 'expected_days', type: 'integer' })
  expectedDays!: number;

  @Column({ name: 'completed_days', type: 'integer' })
  completedDays!: number;

  @Column({ name: 'covered_days', type: 'integer' })
  coveredDays!: number;

  @TextArrayColumn('missing_dates')
  missingDates!: string[];

  /** `<date>:<reason>` */
  @TextArrayColumn('invalid_dates')
  invalidDates!: string[];

  @TextArrayColumn('reasons')
  reasons!: string[];

  /** The forward_high rows (current at this version) the result was computed from. */
  @Column({ name: 'high_ids', type: 'jsonb' })
  highIds!: number[];

  @Column({ name: 'content_hash', type: 'text' })
  contentHash!: string;

  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt!: Date;

  @Column({ name: 'update_run_id', type: 'uuid', nullable: true })
  updateRunId!: string | null;

  @ManyToOne(() => ForwardUpdateRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'update_run_id' })
  updateRun?: Relation<ForwardUpdateRun> | null;
}

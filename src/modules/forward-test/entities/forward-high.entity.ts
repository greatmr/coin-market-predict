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

import { BigintColumn, HasBigintId } from '../../../common/entities/bigint.js';
import { CreatedAtColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { DailyMetricRevision } from '../../daily-metrics/entities/daily-metric-revision.entity.js';
import { HIGH_ELIGIBILITIES, type HighEligibility } from '../forward.constants.js';

import { ForwardDay0Capture } from './forward-day0-capture.entity.js';
import { ForwardEvent } from './forward-event.entity.js';
import { ForwardUpdateRun } from './forward-update-run.entity.js';

/**
 * One High observation of an event's included period, keyed by (event, period start, source,
 * source revision) (PDF p.7). A late source revision adds a new row and supersedes the previous
 * one (`is_current`), so the change history is kept. The High belongs to the event's own CMC id and
 * the USD daily OHLC series of the existing crawler; eligibility is decided per event (p.6). The
 * signal day can also have rows measured from an hourly capture of the same series (gap U1): the
 * post-detection High (DAY0_HOURLY) and the detection hour's earlier High (DAY0_UNPROVEN); those
 * reference their capture instead of a daily revision.
 */
@Entity({ name: 'forward_high' })
@Unique('ux_forward_high_observation', ['eventId', 'periodStart', 'source', 'sourceRevisionId'])
@Unique('ux_forward_high_day0_capture', ['eventId', 'day0CaptureId', 'eligibility'])
@Index('ix_forward_high_event_current', ['eventId', 'isCurrent'])
@Check('forward_high_one_source_row', '(source_revision_id IS NULL) <> (day0_capture_id IS NULL)')
export class ForwardHigh extends HasBigintId {
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => ForwardEvent, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event?: Relation<ForwardEvent>;

  /** UTC calendar date of the period, `YYYY-MM-DD`. */
  @Column({ name: 'date_utc', type: 'date' })
  dateUtc!: string;

  @Column({ name: 'period_start', type: 'timestamptz' })
  periodStart!: Date;

  @Column({ name: 'period_end', type: 'timestamptz' })
  periodEnd!: Date;

  /** e.g. `cmc_web:/data-api/v3.1/cryptocurrency/historical`, `fixture:daily`, `manual_csv_import`. */
  @Column({ type: 'text' })
  source!: string;

  /** The daily row revision; NULL for a row measured from an hourly capture. */
  @BigintColumn({ name: 'source_revision_id', nullable: true })
  sourceRevisionId!: number | null;

  @ManyToOne(() => DailyMetricRevision, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'source_revision_id' })
  sourceRevision?: Relation<DailyMetricRevision> | null;

  /** The hourly capture of the signal day this row was measured from; NULL for a daily row. */
  @BigintColumn({ name: 'day0_capture_id', nullable: true })
  day0CaptureId!: number | null;

  @ManyToOne(() => ForwardDay0Capture, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'day0_capture_id' })
  day0Capture?: Relation<ForwardDay0Capture> | null;

  /** The daily row's revision number (1 for a row from an hourly capture). */
  @Column({ type: 'integer' })
  revision!: number;

  @DecimalColumn(38, 18, { name: 'high_usd', nullable: true })
  highUsd!: DValue | null;

  /** The source's documented time of the High; NULL when unknown (precision: the UTC day). */
  @Column({ name: 'time_high', type: 'timestamptz', nullable: true })
  timeHigh!: Date | null;

  @Column({ name: 'quote_currency', type: 'text', default: 'USD' })
  quoteCurrency!: string;

  /** When the source row was retrieved. */
  @Column({ name: 'observed_at', type: 'timestamptz' })
  observedAt!: Date;

  @Column({
    type: 'enum',
    enum: [...HIGH_ELIGIBILITIES],
    enumName: 'forward_high_eligibility',
  })
  eligibility!: HighEligibility;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'is_current', type: 'boolean', default: true })
  isCurrent!: boolean;

  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  @Column({ name: 'update_run_id', type: 'uuid', nullable: true })
  updateRunId!: string | null;

  @ManyToOne(() => ForwardUpdateRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'update_run_id' })
  updateRun?: Relation<ForwardUpdateRun> | null;

  @CreatedAtColumn()
  createdAt!: Date;
}

import { Column, Entity, JoinColumn, ManyToOne, type Relation, Unique } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';
import { TextArrayColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import {
  ELIGIBILITY_CLASSES,
  EXTREME_ORDERS,
  type EligibilityClass,
  type ExtremeOrder,
  OBSERVATION_STATUSES,
  type ObservationStatus,
} from '../observation.constants.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { Observation } from './observation.entity.js';

/**
 * The terminal result of an observation (FINAL, PARTIAL, DATA_UNAVAILABLE, MAPPING_AMBIGUOUS or
 * ELIGIBILITY_UNKNOWN) as computed, one row per result version. Append-only: a database trigger
 * refuses updates and deletes, so a recalculation under new rules adds a version.
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

  @Column({ name: 'expected_bars', type: 'integer' })
  expectedBars!: number;

  @Column({ name: 'covered_bars', type: 'integer' })
  coveredBars!: number;

  @Column({ name: 'traded_bars', type: 'integer' })
  tradedBars!: number;

  @Column({ name: 'missing_bars', type: 'integer' })
  missingBars!: number;

  @Column({ name: 'missing_ranges', type: 'jsonb' })
  missingRanges!: Array<[string, string]>;

  @Column({ name: 'series_sha256', type: 'text', nullable: true })
  seriesSha256!: string | null;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt!: Date;
}

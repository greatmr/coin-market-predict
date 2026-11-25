import { Column, Entity, JoinColumn, ManyToOne, type Relation, Unique } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';

import { OBSERVATION_STATUSES, type ObservationStatus } from '../observation.constants.js';

import { Observation } from './observation.entity.js';

/**
 * The audit trail of recalculations under a new rules version (append-only, trigger): the values,
 * status and result version an observation had before it moved to the new rules. The observation's
 * freeze trigger refuses a rules change without this row, and a finalized observation reopens only
 * through it (its result rows stay).
 */
@Entity({ name: 'lbank_obs_rules_change' })
@Unique('ux_lbank_obs_rules_change', ['observationId', 'fromRulesVersion', 'toRulesVersion'])
export class ObsRulesChange extends HasBigintId {
  @Column({ name: 'observation_id', type: 'uuid' })
  observationId!: string;

  @ManyToOne(() => Observation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'observation_id' })
  observation?: Relation<Observation>;

  @Column({ name: 'from_rules_version', type: 'text' })
  fromRulesVersion!: string;

  @Column({ name: 'to_rules_version', type: 'text' })
  toRulesVersion!: string;

  @Column({
    name: 'from_status',
    type: 'enum',
    enum: [...OBSERVATION_STATUSES],
    enumName: 'lbank_obs_status',
  })
  fromStatus!: ObservationStatus;

  @Column({ name: 'from_result_version', type: 'integer' })
  fromResultVersion!: number;

  @Column({ name: 'from_finalized_at', type: 'timestamptz', nullable: true })
  fromFinalizedAt!: Date | null;

  /** Every value the observation showed under the old rules. */
  @Column({ type: 'jsonb' })
  previous!: Record<string, unknown>;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'changed_at', type: 'timestamptz' })
  changedAt!: Date;
}

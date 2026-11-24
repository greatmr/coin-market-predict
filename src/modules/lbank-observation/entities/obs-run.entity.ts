import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import { TextArrayColumn } from '../../../common/entities/columns.js';

import { Provider } from '../../sources/entities/provider.entity.js';
import { OBS_RUN_STATUSES, type ObsRunStatus } from '../observation.constants.js';

/** One run of the observation job: pairs fetched, observations updated / finalized, errors. */
@Entity({ name: 'lbank_obs_run' })
@Index('ix_lbank_obs_run_provider', ['providerId', 'startedAt'])
export class ObsRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  /** `schedule`, `manual` or `cli`. */
  @Column({ type: 'text' })
  trigger!: string;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'enum', enum: [...OBS_RUN_STATUSES], enumName: 'lbank_obs_run_status' })
  status!: ObsRunStatus;

  @Column({ type: 'jsonb', nullable: true })
  counts!: Record<string, unknown> | null;

  @TextArrayColumn('notes')
  notes!: string[];

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

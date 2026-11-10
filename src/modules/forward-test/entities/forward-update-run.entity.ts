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

import { PipelineRun } from '../../pipeline/entities/pipeline-run.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import { FORWARD_UPDATE_STATUSES, type ForwardUpdateStatus } from '../forward.constants.js';

/**
 * One daily High update (PDF p.7, p.10): which completed UTC date it covered, what it fetched and
 * recomputed, and whether data was still missing (`partial`, retried later). Its history is the
 * "last successful daily update" and the freshness signal of the forward test.
 */
@Entity({ name: 'forward_update_run' })
@Index('ix_forward_update_run_provider', ['providerId', 'startedAt'])
export class ForwardUpdateRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'pipeline_run_id', type: 'uuid', nullable: true })
  pipelineRunId!: string | null;

  @ManyToOne(() => PipelineRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pipeline_run_id' })
  pipelineRun?: Relation<PipelineRun> | null;

  /** schedule (hourly pipeline, once per closed UTC day) | manual (CLI / dashboard). */
  @Column({ type: 'text' })
  trigger!: string;

  /** The latest completed UTC date at run time, `YYYY-MM-DD`. */
  @Column({ name: 'update_date', type: 'date' })
  updateDate!: string;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'enum', enum: [...FORWARD_UPDATE_STATUSES], enumName: 'forward_update_status' })
  status!: ForwardUpdateStatus;

  @Column({ type: 'jsonb', nullable: true })
  counts!: Record<string, unknown> | null;

  @TextArrayColumn('notes')
  notes!: string[];

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

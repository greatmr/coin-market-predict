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

import { CreatedAtColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';

import { Provider } from '../../sources/entities/provider.entity.js';

export const PIPELINE_RUN_STATUSES = [
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
  'missed',
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

/** One pipeline run per (kind, UTC hour slot, provider); resumed, never duplicated. */
@Entity({ name: 'pipeline_run' })
@Unique('ux_pipeline_run_slot', ['kind', 'slotTime', 'providerId'])
@Index('ix_pipeline_run_started', ['startedAt'])
export class PipelineRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** hourly | manual (free text so the CLI can tag ad-hoc runs). */
  @Column({ type: 'text' })
  kind!: string;

  @Column({ name: 'slot_time', type: 'timestamptz' })
  slotTime!: Date;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ type: 'enum', enum: [...PIPELINE_RUN_STATUSES], enumName: 'pipeline_run_status' })
  status!: PipelineRunStatus;

  @Column({ name: 'current_stage', type: 'text', nullable: true })
  currentStage!: string | null;

  @Column({ type: 'integer', default: 1 })
  attempt!: number;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  /** Coverage summary: assets expected/collected/missing/stale and completeness label. */
  @Column({ type: 'jsonb', nullable: true })
  coverage!: unknown;

  /** Stage timings, stage reports, item progress of the running stage, degraded reasons. */
  @Column({ type: 'jsonb', nullable: true })
  metrics!: unknown;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'is_live_data', type: 'boolean' })
  isLiveData!: boolean;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

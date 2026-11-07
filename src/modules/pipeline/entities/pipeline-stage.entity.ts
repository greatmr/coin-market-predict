import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';

import { PipelineRun } from './pipeline-run.entity.js';

export const PIPELINE_STAGE_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;
export type PipelineStageStatus = (typeof PIPELINE_STAGE_STATUSES)[number];

/** One record per stage of a run (`progress.ts` STAGES); completed stages are skipped on resume. */
@Entity({ name: 'pipeline_stage' })
@Unique('ux_pipeline_stage_run_stage', ['runId', 'stage'])
export class PipelineStage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId!: string;

  @ManyToOne(() => PipelineRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: Relation<PipelineRun>;

  @Column({ type: 'text' })
  stage!: string;

  @Column({ type: 'enum', enum: [...PIPELINE_STAGE_STATUSES], enumName: 'pipeline_stage_status' })
  status!: PipelineStageStatus;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'integer', default: 1 })
  attempts!: number;

  @Column({ type: 'jsonb', nullable: true })
  detail!: unknown;

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

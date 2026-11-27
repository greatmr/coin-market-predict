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

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { PipelineRun } from '../../pipeline/entities/pipeline-run.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import {
  type BatchStatus,
  CRAWL_STATUSES,
  QUEUE_STATUSES,
  type QueueStatus,
} from '../../strategy/index.js';

/** What one intake did with one published queue row (the no-missed-event check reads these). */
export interface IntakeDetails {
  created: Array<{ eventId: string; cmcId: number; stars: number }>;
  /** `deletedKey`: the key belongs to a deleted cohort (M021): taken, as the original event was. */
  ignored: Array<{ cmcId: number; stars: number; eventId: string | null; deletedKey?: boolean }>;
  rejected: Array<{
    cmcId: number | null;
    symbol: string;
    stars: number;
    reasons: string[];
    observed: Record<string, unknown>;
  }>;
}

/**
 * One reading of a batch's published Review Queue by the LBank observation intake: every queue row is
 * created, ignored (its key exists: the event keeps its first sighting) or rejected with reasons, so
 * `queue_rows = created + ignored + rejected` proves no row was dropped.
 */
@Entity({ name: 'lbank_obs_intake_run' })
@Index('ix_lbank_obs_intake_run_batch', ['batchId'])
@Index('ix_lbank_obs_intake_run_provider', ['providerId', 'intakeAt'])
export class ObsIntakeRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => CrawlBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch>;

  @Column({ name: 'pipeline_run_id', type: 'uuid', nullable: true })
  pipelineRunId!: string | null;

  @ManyToOne(() => PipelineRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pipeline_run_id' })
  pipelineRun?: Relation<PipelineRun> | null;

  @Column({ name: 'intake_at', type: 'timestamptz' })
  intakeAt!: Date;

  @Column({
    name: 'queue_status',
    type: 'enum',
    enum: [...QUEUE_STATUSES],
    enumName: 'queue_status',
    nullable: true,
  })
  queueStatus!: QueueStatus | null;

  @Column({
    name: 'batch_status',
    type: 'enum',
    enum: [...CRAWL_STATUSES],
    enumName: 'crawl_status',
  })
  batchStatus!: BatchStatus;

  @Column({ name: 'queue_rows', type: 'integer' })
  queueRows!: number;

  @Column({ type: 'integer' })
  created!: number;

  @Column({ type: 'integer' })
  ignored!: number;

  @Column({ type: 'integer' })
  rejected!: number;

  @Column({ type: 'jsonb' })
  details!: IntakeDetails;

  @TextArrayColumn('notes')
  notes!: string[];
}

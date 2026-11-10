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

/**
 * One reading of a batch's published Review Queue by the trigger (append-only): how many rows it
 * saw and how many events it created, ignored as duplicates of an existing key, or rejected.
 */
@Entity({ name: 'forward_trigger_run' })
@Index('ix_forward_trigger_run_batch', ['batchId'])
@Index('ix_forward_trigger_run_provider', ['providerId', 'triggeredAt'])
export class ForwardTriggerRun {
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

  @Column({ name: 'triggered_at', type: 'timestamptz' })
  triggeredAt!: Date;

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

  /** Created event ids and the ignored sightings with the event that already holds their key. */
  @Column({ type: 'jsonb' })
  details!: {
    created: string[];
    ignored: Array<{ cmcId: number; stars: number; eventId: string | null }>;
  };

  @TextArrayColumn('notes')
  notes!: string[];
}

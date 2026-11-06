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

import {
  CreatedAtColumn,
  IntArrayColumn,
  TextArrayColumn,
  UpdatedAtColumn,
} from '../../../common/entities/columns.js';

import { PipelineRun } from '../../pipeline/entities/pipeline-run.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import { type BatchStatus, CRAWL_STATUSES } from '../../strategy/index.js';

/**
 * One crawl batch per provider and UTC hour slot (PDF p.16 crawl_batches), computed from the
 * snapshots actually stored. COMPLETE needs the whole listing and contiguous ranks 1–1200.
 */
@Entity({ name: 'crawl_batch' })
@Unique('ux_crawl_batch_slot', ['providerId', 'slotTime'])
@Index('ix_crawl_batch_provider_crawled', ['providerId', 'crawledAt'])
export class CrawlBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'slot_time', type: 'timestamptz' })
  slotTime!: Date;

  @Column({ name: 'pipeline_run_id', type: 'uuid', nullable: true })
  pipelineRunId!: string | null;

  @ManyToOne(() => PipelineRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pipeline_run_id' })
  pipelineRun?: Relation<PipelineRun> | null;

  @Column({ name: 'is_live', type: 'boolean' })
  isLive!: boolean;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz' })
  finishedAt!: Date;

  /** Crawl time of the batch's observations; the Tier 1 rules' as-of time (assumption A1). */
  @Column({ name: 'crawled_at', type: 'timestamptz' })
  crawledAt!: Date;

  @Column({ name: 'source_updated_min', type: 'timestamptz', nullable: true })
  sourceUpdatedMin!: Date | null;

  @Column({ name: 'source_updated_max', type: 'timestamptz', nullable: true })
  sourceUpdatedMax!: Date | null;

  @Column({ type: 'enum', enum: [...CRAWL_STATUSES], enumName: 'crawl_status' })
  status!: BatchStatus;

  @TextArrayColumn('status_reasons')
  statusReasons!: string[];

  /** Assets the source reports it lists (null = unknown). */
  @Column({ name: 'listed_total', type: 'integer', nullable: true })
  listedTotal!: number | null;

  @Column({ type: 'integer' })
  collected!: number;

  /** field → number of observations with a non-null value. */
  @Column({ name: 'field_counts', type: 'jsonb' })
  fieldCounts!: Record<string, number>;

  /** Ranks 1..1200 absent from the batch, and ranks seen more than once. */
  @IntArrayColumn('missing_ranks')
  missingRanks!: number[];

  @IntArrayColumn('duplicate_ranks')
  duplicateRanks!: number[];

  @Column({ type: 'jsonb', nullable: true })
  errors!: unknown;

  @TextArrayColumn('notes')
  notes!: string[];

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

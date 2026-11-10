import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation, Unique } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';
import { CreatedAtColumn, TextArrayColumn } from '../../../common/entities/columns.js';

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';

import { ForwardTriggerRun } from './forward-trigger-run.entity.js';

/**
 * A Review Queue row that did not open a priced event, with every reason (PDF p.3, p.8, p.10):
 * invalid or stale price, ambiguous asset id, incomplete batch or withheld queue. Nothing is
 * fabricated: the observed values are kept as they were. One row per batch, asset and star count.
 */
@Entity({ name: 'forward_trigger_rejection' })
@Unique('ux_forward_trigger_rejection', ['batchId', 'cmcId', 'starCount'])
@Index('ix_forward_trigger_rejection_provider', ['providerId', 'createdAt'])
export class ForwardTriggerRejection extends HasBigintId {
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

  @Column({ name: 'trigger_run_id', type: 'uuid' })
  triggerRunId!: string;

  @ManyToOne(() => ForwardTriggerRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trigger_run_id' })
  triggerRun?: Relation<ForwardTriggerRun>;

  @Column({ name: 'cmc_id', type: 'integer', nullable: true })
  cmcId!: number | null;

  @Column({ type: 'text', nullable: true })
  symbol!: string | null;

  @Column({ name: 'star_count', type: 'integer' })
  starCount!: number;

  @TextArrayColumn('reasons')
  reasons!: string[];

  /** The values the trigger saw (price text, timestamps, statuses), never repaired. */
  @Column({ type: 'jsonb' })
  observed!: Record<string, unknown>;

  @CreatedAtColumn()
  createdAt!: Date;
}

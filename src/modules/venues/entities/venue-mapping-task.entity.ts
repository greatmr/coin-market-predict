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

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import { MAPPING_TASK_KINDS, type MappingTaskKind } from '../../strategy/index.js';

import { VenueDecision } from './venue-decision.entity.js';

export const MAPPING_TASK_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type MappingTaskStatus = (typeof MAPPING_TASK_STATUSES)[number];

/** Saved mapping-evidence task for an ambiguous LBank base ticker (PDF p.10). */
@Entity({ name: 'venue_mapping_task' })
@Unique('ux_venue_mapping_task_pair', ['providerId', 'cmcId', 'exchange', 'marketPair', 'kind'])
@Index('ix_venue_mapping_task_status', ['providerId', 'status'])
export class VenueMappingTask {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @Column({ type: 'text' })
  exchange!: string;

  @Column({ name: 'market_pair', type: 'text' })
  marketPair!: string;

  @Column({ type: 'enum', enum: [...MAPPING_TASK_KINDS], enumName: 'mapping_task_kind' })
  kind!: MappingTaskKind;

  @Column({ type: 'jsonb' })
  evidence!: Record<string, unknown>;

  @Column({ type: 'enum', enum: [...MAPPING_TASK_STATUSES], enumName: 'mapping_task_status' })
  status!: MappingTaskStatus;

  @Column({ name: 'first_seen_batch_id', type: 'uuid', nullable: true })
  firstSeenBatchId!: string | null;

  @ManyToOne(() => CrawlBatch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'first_seen_batch_id' })
  firstSeenBatch?: Relation<CrawlBatch> | null;

  @Column({ name: 'last_seen_batch_id', type: 'uuid', nullable: true })
  lastSeenBatchId!: string | null;

  @ManyToOne(() => CrawlBatch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'last_seen_batch_id' })
  lastSeenBatch?: Relation<CrawlBatch> | null;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolved_by_decision_id', type: 'uuid', nullable: true })
  resolvedByDecisionId!: string | null;

  @ManyToOne(() => VenueDecision, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by_decision_id' })
  resolvedByDecision?: Relation<VenueDecision> | null;
}

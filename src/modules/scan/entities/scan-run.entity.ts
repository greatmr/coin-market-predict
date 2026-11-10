import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';

import { TextArrayColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import { QUEUE_STATUSES, type QueueStatus } from '../../strategy/index.js';
import { VenueCrawl } from '../../venues/entities/venue-crawl.entity.js';

export const SCAN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const EXPORT_STATUSES = ['succeeded', 'failed'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** Processing of one crawl batch (counts, warnings, queue status, export). Reprocessing updates it. */
@Entity({ name: 'scan_run' })
@Index('ix_scan_run_provider_as_of', ['providerId', 'asOf'])
export class ScanRun {
  @PrimaryColumn({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => CrawlBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch>;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'is_live', type: 'boolean' })
  isLive!: boolean;

  @Column({ name: 'ruleset_version', type: 'text' })
  rulesetVersion!: string;

  @Column({ name: 'config_version', type: 'text' })
  configVersion!: string;

  @Column({ name: 'overrides_version', type: 'text' })
  overridesVersion!: string;

  /** Review Queue ranking that produced `queue_order` (NULL: scanned before weighted_star_v1). */
  @Column({ name: 'ranking_ruleset_version', type: 'text', nullable: true })
  rankingRulesetVersion!: string | null;

  @Column({ type: 'integer', default: 1 })
  attempts!: number;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'enum', enum: [...SCAN_STATUSES], enumName: 'scan_status' })
  status!: ScanStatus;

  /** The rules' as-of time: the batch's crawl time (A1). */
  @Column({ name: 'as_of', type: 'timestamptz' })
  asOf!: Date;

  @Column({
    name: 'queue_status',
    type: 'enum',
    enum: [...QUEUE_STATUSES],
    enumName: 'queue_status',
    nullable: true,
  })
  queueStatus!: QueueStatus | null;

  @Column({ type: 'jsonb', nullable: true })
  counts!: Record<string, unknown> | null;

  @TextArrayColumn('warnings')
  warnings!: string[];

  @Column({ name: 'lbank_crawl_id', type: 'uuid', nullable: true })
  lbankCrawlId!: string | null;

  @ManyToOne(() => VenueCrawl, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'lbank_crawl_id' })
  lbankCrawl?: Relation<VenueCrawl> | null;

  @Column({
    name: 'export_status',
    type: 'enum',
    enum: [...EXPORT_STATUSES],
    enumName: 'export_status',
    nullable: true,
  })
  exportStatus!: ExportStatus | null;

  @Column({ name: 'export_path', type: 'text', nullable: true })
  exportPath!: string | null;

  @Column({ name: 'export_files', type: 'jsonb', nullable: true })
  exportFiles!: Array<{ name: string; rows: number; bytes: number; sha256: string }> | null;

  @Column({ name: 'exported_at', type: 'timestamptz', nullable: true })
  exportedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

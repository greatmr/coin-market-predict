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
import { Provider } from '../../sources/entities/provider.entity.js';
import { type BatchStatus, CRAWL_STATUSES, type VenuePair } from '../../strategy/index.js';

export const VENUE_CRAWL_KINDS = [
  'lbank_spot_pairs',
  'asset_markets',
  'lbank_futures_pairs',
  'bithumb_spot_pairs',
] as const;
export type VenueCrawlKind = (typeof VENUE_CRAWL_KINDS)[number];

/**
 * One venue crawl: all LBank Spot pairs (`lbank_spot_pairs`), one asset's CMC Markets spot pairs
 * (`asset_markets`), or since M012 all LBank Futures pairs (`lbank_futures_pairs`: perpetual and
 * dated futures) or all Bithumb Spot pairs (`bithumb_spot_pairs`), the listing attributes of
 * ADR-0007 that no Tier 1 rule reads. `pairs` keeps the normalized rows exactly as used (PDF p.10,
 * p.15).
 */
@Entity({ name: 'venue_crawl' })
@Index('ix_venue_crawl_kind', ['providerId', 'kind', 'finishedAt'])
@Index('ix_venue_crawl_asset', ['providerId', 'kind', 'cmcId', 'finishedAt'])
export class VenueCrawl {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ type: 'enum', enum: [...VENUE_CRAWL_KINDS], enumName: 'venue_crawl_kind' })
  kind!: VenueCrawlKind;

  @Column({ name: 'cmc_id', type: 'integer', nullable: true })
  cmcId!: number | null;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @ManyToOne(() => CrawlBatch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch> | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz' })
  finishedAt!: Date;

  @Column({ type: 'enum', enum: [...CRAWL_STATUSES], enumName: 'crawl_status' })
  status!: BatchStatus;

  @Column({ name: 'expected_count', type: 'integer', nullable: true })
  expectedCount!: number | null;

  @Column({ name: 'fetched_count', type: 'integer' })
  fetchedCount!: number;

  @Column({ type: 'integer', default: 0 })
  requests!: number;

  @Column({ type: 'jsonb' })
  pairs!: VenuePair[];

  @Column({ type: 'jsonb', nullable: true })
  summary!: Record<string, unknown> | null;

  @Column({ type: 'text' })
  source!: string;

  @Column({ name: 'source_params', type: 'jsonb' })
  sourceParams!: Record<string, string>;

  @TextArrayColumn('response_sha256')
  responseSha256!: string[];

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @TextArrayColumn('notes')
  notes!: string[];
}

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

import { Provider } from '../../sources/entities/provider.entity.js';

import { CrawlBatch } from './crawl-batch.entity.js';

/**
 * CMC asset identity (PDF p.10): the numeric CMC id is the key; symbol/name/slug/tags are
 * metadata whose changes are logged in `cmc_asset_change` without creating a new asset.
 */
@Entity({ name: 'cmc_asset' })
@Index('ix_cmc_asset_provider_symbol', ['providerId', 'symbol'])
export class CmcAsset {
  @PrimaryColumn({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @PrimaryColumn({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @Column({ type: 'text' })
  symbol!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  slug!: string | null;

  @TextArrayColumn('tags')
  tags!: string[];

  @Column({ name: 'date_added', type: 'timestamptz', nullable: true })
  dateAdded!: Date | null;

  @Column({ name: 'platform_chain', type: 'text', nullable: true })
  platformChain!: string | null;

  @Column({ name: 'platform_address', type: 'text', nullable: true })
  platformAddress!: string | null;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  @Column({ name: 'last_batch_id', type: 'uuid', nullable: true })
  lastBatchId!: string | null;

  @ManyToOne(() => CrawlBatch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'last_batch_id' })
  lastBatch?: Relation<CrawlBatch> | null;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

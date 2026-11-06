import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';

import { Provider } from '../../sources/entities/provider.entity.js';

import { CrawlBatch } from './crawl-batch.entity.js';

/** One metadata change of a CMC asset (symbol | name | slug | tags | dateAdded | platform). */
@Entity({ name: 'cmc_asset_change' })
@Index('ix_cmc_asset_change_asset', ['providerId', 'cmcId', 'observedAt'])
export class CmcAssetChange extends HasBigintId {
  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @Column({ type: 'text' })
  field!: string;

  @Column({ name: 'old_value', type: 'text', nullable: true })
  oldValue!: string | null;

  @Column({ name: 'new_value', type: 'text', nullable: true })
  newValue!: string | null;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @ManyToOne(() => CrawlBatch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch> | null;

  @Column({ name: 'observed_at', type: 'timestamptz' })
  observedAt!: Date;
}

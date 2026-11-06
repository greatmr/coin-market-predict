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

import { Provider } from '../../sources/entities/provider.entity.js';

import { Asset } from './asset.entity.js';

/** Mapping of a provider's asset id to the canonical asset. */
@Entity({ name: 'asset_identity' })
@Unique('ux_asset_identity_provider_asset', ['providerId', 'providerAssetId'])
@Index('ix_asset_identity_asset', ['assetId'])
export class AssetIdentity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @ManyToOne(() => Asset, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'asset_id' })
  asset?: Relation<Asset>;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'provider_asset_id', type: 'text' })
  providerAssetId!: string;

  @Column({ name: 'source_url', type: 'text', nullable: true })
  sourceUrl!: string | null;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  /** Set when the provider no longer lists the asset during a complete discovery sweep. */
  @Column({ name: 'delisted_at', type: 'timestamptz', nullable: true })
  delistedAt!: Date | null;
}

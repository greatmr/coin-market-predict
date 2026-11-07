import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { CreatedAtColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';

import { ASSET_CLASSES, type AssetClass } from '../classify.js';

/** Canonical asset. Identity is never derived from the symbol alone. */
@Entity({ name: 'asset' })
@Index('ix_asset_symbol', ['symbol'])
@Index('ix_asset_class', ['assetClass'])
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  symbol!: string;

  /** Classification from discovery / collection; only ever made stricter (`classify.ts`). */
  @Column({
    name: 'asset_class',
    type: 'enum',
    enum: [...ASSET_CLASSES],
    enumName: 'asset_class',
    default: 'unknown',
  })
  assetClass!: AssetClass;

  /** provider_category | heuristic_name | heuristic_symbol | heuristic_price | default | manual */
  @Column({ name: 'class_source', type: 'text', nullable: true })
  classSource!: string | null;

  /** e.g. "bitcoin" for wrapped BTC exposure. */
  @Column({ name: 'underlying_asset', type: 'text', nullable: true })
  underlyingAsset!: string | null;

  /** BTC/ETH reference assets. */
  @Column({ name: 'is_benchmark', type: 'boolean', default: false })
  isBenchmark!: boolean;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  @Column({ name: 'delisted_at', type: 'timestamptz', nullable: true })
  delistedAt!: Date | null;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

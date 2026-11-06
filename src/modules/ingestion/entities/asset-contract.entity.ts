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

import { CreatedAtColumn } from '../../../common/entities/columns.js';

import { Provider } from '../../sources/entities/provider.entity.js';

import { Asset } from './asset.entity.js';

/** Chain + contract address (EVM addresses lower-cased): the only cross-provider identity link. */
@Entity({ name: 'asset_contract' })
@Unique('ux_asset_contract_chain_address', ['chain', 'contractAddress'])
@Index('ix_asset_contract_asset', ['assetId'])
export class AssetContract {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @ManyToOne(() => Asset, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'asset_id' })
  asset?: Relation<Asset>;

  @Column({ type: 'text' })
  chain!: string;

  @Column({ name: 'contract_address', type: 'text' })
  contractAddress!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ type: 'integer', nullable: true })
  decimals!: number | null;

  @CreatedAtColumn()
  createdAt!: Date;
}

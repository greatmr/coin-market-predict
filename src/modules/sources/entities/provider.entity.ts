import { Column, Entity, PrimaryColumn } from 'typeorm';

import { CreatedAtColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';

import { PROVIDER_ACCESS_METHODS, type ProviderAccessMethod } from '../source.types.js';

/** A market-data source, e.g. "fixture" or "coinmarketcap_web". Non-live data must be labelled. */
@Entity({ name: 'provider' })
export class Provider {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({
    name: 'access_method',
    type: 'enum',
    enum: [...PROVIDER_ACCESS_METHODS],
    enumName: 'provider_access_method',
  })
  accessMethod!: ProviderAccessMethod;

  /** False for fixtures; dashboards, exports and reports label non-live data. */
  @Column({ name: 'is_live', type: 'boolean' })
  isLive!: boolean;

  @Column({ name: 'base_url', type: 'text', nullable: true })
  baseUrl!: string | null;

  @Column({ name: 'terms_url', type: 'text', nullable: true })
  termsUrl!: string | null;

  @Column({ type: 'text', nullable: true })
  attribution!: string | null;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

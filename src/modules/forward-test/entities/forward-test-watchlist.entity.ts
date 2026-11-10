import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';

import { CreatedAtColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';

import { Provider } from '../../sources/entities/provider.entity.js';

/**
 * Forward_Test_Watchlist (PDF p.3): the automatically managed list of assets with forward-test
 * events. The scanner's first qualifying result adds the asset — there is no approval step and no
 * manual list behind it. A row identifies the asset; `forward_event` rows identify each
 * star/date observation and reference it (removing an asset can never delete its events).
 */
@Entity({ name: 'forward_test_watchlist' })
@Index('ix_forward_test_watchlist_last_event', ['providerId', 'lastEventAt'])
export class ForwardTestWatchlist {
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

  /** Contract / network evidence at the first event (never matched by symbol). */
  @Column({ name: 'platform_chain', type: 'text', nullable: true })
  platformChain!: string | null;

  @Column({ name: 'platform_address', type: 'text', nullable: true })
  platformAddress!: string | null;

  @Column({ name: 'is_live', type: 'boolean' })
  isLive!: boolean;

  @Column({ name: 'first_event_at', type: 'timestamptz' })
  firstEventAt!: Date;

  @Column({ name: 'last_event_at', type: 'timestamptz' })
  lastEventAt!: Date;

  @Column({ name: 'event_count', type: 'integer', default: 0 })
  eventCount!: number;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

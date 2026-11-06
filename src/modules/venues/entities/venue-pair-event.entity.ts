import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';

import { Provider } from '../../sources/entities/provider.entity.js';

import { VenueCrawl } from './venue-crawl.entity.js';

export const PAIR_EVENTS = ['LISTED', 'ABSENT'] as const;
export type PairEvent = (typeof PAIR_EVENTS)[number];

/** LBank pair listing transitions (first seen / reappeared / absent in a complete crawl; A9, A12). */
@Entity({ name: 'venue_pair_event' })
@Index('ix_venue_pair_event_pair', ['providerId', 'exchange', 'cmcId', 'at'])
export class VenuePairEvent extends HasBigintId {
  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ type: 'text' })
  exchange!: string;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @Column({ name: 'market_pair', type: 'text' })
  marketPair!: string;

  @Column({ type: 'enum', enum: [...PAIR_EVENTS], enumName: 'pair_event' })
  event!: PairEvent;

  @Column({ name: 'crawl_id', type: 'uuid' })
  crawlId!: string;

  @ManyToOne(() => VenueCrawl, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'crawl_id' })
  crawl?: Relation<VenueCrawl>;

  @Column({ type: 'timestamptz' })
  at!: Date;
}

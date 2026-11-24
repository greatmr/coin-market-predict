import { Column, Entity, Index } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';

import { MARKET_LIST_KINDS, type MarketListKind } from '../observation.constants.js';

/**
 * One fetch of an LBank markets list used as eligibility evidence at a signal (Spot pairs, Futures
 * contracts): when, from where, how many entries and the content hash. Each observation keeps the
 * extract it used (its pair or contract) in its own evidence; the full list is not stored.
 */
@Entity({ name: 'lbank_market_list_fetch' })
@Index('ix_lbank_market_list_fetch_kind', ['kind', 'fetchedAt'])
export class MarketListFetch extends HasBigintId {
  @Column({ type: 'enum', enum: [...MARKET_LIST_KINDS], enumName: 'lbank_market_list_kind' })
  kind!: MarketListKind;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  @Column({ type: 'boolean' })
  ok!: boolean;

  @Column({ type: 'text' })
  source!: string;

  @Column({ name: 'item_count', type: 'integer' })
  itemCount!: number;

  @Column({ name: 'content_sha256', type: 'text', nullable: true })
  contentSha256!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

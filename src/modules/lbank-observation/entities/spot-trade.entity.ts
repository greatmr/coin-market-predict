import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';

import type { DValue } from '../../../common/utils/decimal.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { SpotPair } from './spot-pair.entity.js';

/**
 * One LBank Spot trade (`/v2/supplement/trades.do`) as the API sent it, stored once per pair and
 * trade id and shared by every observation of the pair. Only minutes whose complete trade list was
 * read (`lbank_spot_trade_minute`) are stored: the reference minute, the boundary minutes and the
 * candidate minutes of the extremes. Immutable (trigger).
 */
@Entity({ name: 'lbank_spot_trade' })
@Index('ix_lbank_spot_trade_time', ['pairId', 'tradedAt', 'msOrd'])
@Check('lbank_spot_trade_values', 'price > 0 AND qty > 0 AND ms_ord >= 0')
export class SpotTrade {
  @PrimaryColumn({ name: 'pair_id', type: 'integer' })
  pairId!: number;

  @ManyToOne(() => SpotPair, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pair_id' })
  pair?: Relation<SpotPair>;

  @PrimaryColumn({ name: 'trade_id', type: 'text' })
  tradeId!: string;

  /** The trade's millisecond UTC time. */
  @Column({ name: 'traded_at', type: 'timestamptz' })
  tradedAt!: Date;

  /** Position among the pair's trades of the same millisecond in LBank's (stable) response order. */
  @Column({ name: 'ms_ord', type: 'integer' })
  msOrd!: number;

  @ExactNumericColumn({ name: 'price' })
  price!: DValue;

  @ExactNumericColumn({ name: 'qty' })
  qty!: DValue;

  @Column({ name: 'is_buyer_maker', type: 'boolean', nullable: true })
  isBuyerMaker!: boolean | null;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;
}

import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';

import { TextArrayColumn } from '../../../common/entities/columns.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { TRADE_CHECK_STATUSES, type TradeCheckStatus } from '../observation.constants.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { SpotPair } from './spot-pair.entity.js';

/**
 * The check of one minute's complete LBank Spot trade list against its candle (rules v2): pages
 * read (exclusive `time` paging, de-duplicated by id), trade count and quantity against the candle
 * volume, and the outcome. Shared by every observation of the pair. A VERIFIED check is immutable
 * (trigger); other outcomes are retried and updated (`attempts`, `error`).
 */
@Entity({ name: 'lbank_spot_trade_minute' })
@Check('lbank_spot_trade_minute_whole', 'mod(extract(epoch FROM minute_at), 60) = 0')
export class TradeMinute {
  @PrimaryColumn({ name: 'pair_id', type: 'integer' })
  pairId!: number;

  @ManyToOne(() => SpotPair, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pair_id' })
  pair?: Relation<SpotPair>;

  @PrimaryColumn({ name: 'minute_at', type: 'timestamptz' })
  minuteAt!: Date;

  @Column({
    type: 'enum',
    enum: [...TRADE_CHECK_STATUSES],
    enumName: 'lbank_trade_check_status',
  })
  status!: TradeCheckStatus;

  @Column({ name: 'trade_count', type: 'integer', nullable: true })
  tradeCount!: number | null;

  @ExactNumericColumn({ name: 'qty_sum', nullable: true })
  qtySum!: DValue | null;

  @ExactNumericColumn({ name: 'candle_volume', nullable: true })
  candleVolume!: DValue | null;

  /** qty_sum − candle_volume when verified (≥ 0: the candle's undercount). */
  @ExactNumericColumn({ name: 'candle_surplus', nullable: true })
  candleSurplus!: DValue | null;

  @Column({ type: 'integer' })
  pages!: number;

  @Column({ type: 'integer', default: 1 })
  attempts!: number;

  @TextArrayColumn('responses_sha256')
  responsesSha256!: string[];

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'first_checked_at', type: 'timestamptz' })
  firstCheckedAt!: Date;

  @Column({ name: 'checked_at', type: 'timestamptz' })
  checkedAt!: Date;
}

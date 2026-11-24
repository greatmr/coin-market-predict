import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';

import type { DValue } from '../../../common/utils/decimal.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { SpotPair } from './spot-pair.entity.js';

/**
 * One closed LBank Spot 1-minute candle, as the API sent it (exact digits), stored once per pair and
 * minute and shared by every observation of the pair. Closed bars are immutable (first write wins);
 * the minute still in progress is never stored.
 */
@Entity({ name: 'lbank_spot_candle' })
@Check(
  'lbank_spot_candle_values',
  'low > 0 AND high >= low AND volume >= 0 AND open > 0 AND close > 0',
)
export class SpotCandle {
  @PrimaryColumn({ name: 'pair_id', type: 'integer' })
  pairId!: number;

  @ManyToOne(() => SpotPair, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pair_id' })
  pair?: Relation<SpotPair>;

  /** UTC open time of the minute. */
  @PrimaryColumn({ name: 'open_time', type: 'timestamptz' })
  openTime!: Date;

  @ExactNumericColumn({ name: 'open' })
  open!: DValue;

  @ExactNumericColumn({ name: 'high' })
  high!: DValue;

  @ExactNumericColumn({ name: 'low' })
  low!: DValue;

  @ExactNumericColumn({ name: 'close' })
  close!: DValue;

  @ExactNumericColumn({ name: 'volume' })
  volume!: DValue;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;
}

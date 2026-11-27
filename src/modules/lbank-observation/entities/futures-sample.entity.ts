import {
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
import { FuturesPoll } from './futures-poll.entity.js';

/**
 * One contract in one LBank Futures `marketData` snapshot (Futures sampled observation, rules
 * `lbank-futures-sampled-1`), stored only for contracts an open observation needs. `server_at` is the
 * snapshot's own refresh time (`lastTime`, whole seconds), not a trade time. Immutable (trigger).
 */
@Entity({ name: 'lbank_futures_sample' })
@Index('ix_lbank_futures_sample_poll', ['pollId'])
export class FuturesSample {
  @PrimaryColumn({ type: 'text' })
  contract!: string;

  @PrimaryColumn({ name: 'server_at', type: 'timestamptz' })
  serverAt!: Date;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  @ExactNumericColumn({ name: 'last_price' })
  lastPrice!: DValue;

  @ExactNumericColumn({ name: 'turnover_24h' })
  turnover24h!: DValue;

  @ExactNumericColumn({ name: 'volume_24h' })
  volume24h!: DValue;

  @ExactNumericColumn({ name: 'high_24h', nullable: true })
  high24h!: DValue | null;

  @ExactNumericColumn({ name: 'low_24h', nullable: true })
  low24h!: DValue | null;

  @ExactNumericColumn({ name: 'mark_price', nullable: true })
  markPrice!: DValue | null;

  @Column({ name: 'instrument_status', type: 'text', nullable: true })
  instrumentStatus!: string | null;

  @Column({ name: 'response_sha256', type: 'text' })
  responseSha256!: string;

  /** The request that returned this snapshot (since 2026-11-27; null on older rows). */
  @Column({ name: 'poll_id', type: 'bigint', nullable: true })
  pollId!: string | null;

  @ManyToOne(() => FuturesPoll, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'poll_id' })
  poll?: Relation<FuturesPoll>;

  @Column({
    name: 'stored_at',
    type: 'timestamptz',
    nullable: true,
    default: () => 'clock_timestamp()',
  })
  storedAt!: Date | null;
}

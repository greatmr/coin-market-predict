import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import type { DValue } from '../../../common/utils/decimal.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { FuturesObservation } from './futures-observation.entity.js';

/**
 * Order-book context for a Futures observation, read right after its first quote at publication
 * (`marketOrder`, no exchange timestamp): best bid / ask and the returned depth, with our request
 * and response times. Indicative only — never the Futures reference, never an entry or fill price.
 * Immutable.
 */
@Entity({ name: 'lbank_futures_book' })
@Index('ix_lbank_futures_book_obs', ['futuresObservationId'])
export class FuturesBook {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'futures_observation_id', type: 'uuid' })
  futuresObservationId!: string;

  @ManyToOne(() => FuturesObservation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'futures_observation_id' })
  futuresObservation?: Relation<FuturesObservation>;

  @Column({ type: 'text' })
  contract!: string;

  @Column({ type: 'text' })
  endpoint!: string;

  @Column({ name: 'request_started_at', type: 'timestamptz', nullable: true })
  requestStartedAt!: Date | null;

  @Column({ name: 'response_received_at', type: 'timestamptz' })
  responseReceivedAt!: Date;

  @Column({ name: 'stored_at', type: 'timestamptz', default: () => 'clock_timestamp()' })
  storedAt!: Date;

  @Column({ type: 'boolean' })
  ok!: boolean;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @ExactNumericColumn({ name: 'best_bid', nullable: true })
  bestBid!: DValue | null;

  @ExactNumericColumn({ name: 'best_ask', nullable: true })
  bestAsk!: DValue | null;

  @Column({ type: 'jsonb', nullable: true })
  bids!: Array<{ price: string; volume: string; orders: string | null }> | null;

  @Column({ type: 'jsonb', nullable: true })
  asks!: Array<{ price: string; volume: string; orders: string | null }> | null;

  @Column({ name: 'response_sha256', type: 'text', nullable: true })
  responseSha256!: string | null;
}

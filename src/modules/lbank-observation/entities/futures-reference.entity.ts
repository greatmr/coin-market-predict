import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';

import type { DValue } from '../../../common/utils/decimal.js';

import { QUOTE_SOURCES, type QuoteSource } from '../futures-quote-rules.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { FuturesObservation } from './futures-observation.entity.js';
import { FuturesPoll } from './futures-poll.entity.js';

export const FUTURES_REFERENCE_KINDS = ['ENTRY', 'POST_FIX'] as const;
export type FuturesReferenceKind = (typeof FUTURES_REFERENCE_KINDS)[number];

/**
 * An observed Futures quote chosen for an observation (rules `lbank-futures-quote-1`):
 *  - ENTRY: the first valid `lastPrice` observed from a request sent at or after the actionable
 *    start (the Futures reference of events detected after 2026-11-27's fix);
 *  - POST_FIX: for an event whose window was already running at the fix, the first price observed
 *    after the fix — shown apart, never as its entry reference.
 * The earliest receipt wins: a row only ever moves to an earlier response (trigger). The quote's
 * time is OUR observation (request sent / response received); LBank gives no trade time.
 */
@Entity({ name: 'lbank_futures_reference' })
@Unique('ux_lbank_futures_reference_kind', ['futuresObservationId', 'kind'])
@Check('lbank_futures_reference_sent_after_start', 'request_started_at >= actionable_start')
@Check('lbank_futures_reference_received_after_sent', 'response_received_at >= request_started_at')
@Check('lbank_futures_reference_price_positive', 'last_price > 0')
export class FuturesReference {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'futures_observation_id', type: 'uuid' })
  futuresObservationId!: string;

  @ManyToOne(() => FuturesObservation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'futures_observation_id' })
  futuresObservation?: Relation<FuturesObservation>;

  @Column({
    type: 'enum',
    enum: [...FUTURES_REFERENCE_KINDS],
    enumName: 'lbank_fut_reference_kind',
  })
  kind!: FuturesReferenceKind;

  @Column({ name: 'rules_version', type: 'text' })
  rulesVersion!: string;

  @Column({ type: 'text' })
  contract!: string;

  @Column({ name: 'actionable_start', type: 'timestamptz' })
  actionableStart!: Date;

  @Column({ name: 'poll_id', type: 'bigint' })
  pollId!: string;

  @ManyToOne(() => FuturesPoll, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'poll_id' })
  poll?: Relation<FuturesPoll>;

  @Column({ type: 'enum', enum: [...QUOTE_SOURCES], enumName: 'lbank_fut_request_trigger' })
  source!: QuoteSource;

  @Column({ type: 'text' })
  endpoint!: string;

  @Column({ name: 'request_queued_at', type: 'timestamptz', nullable: true })
  requestQueuedAt!: Date | null;

  @Column({ name: 'request_started_at', type: 'timestamptz' })
  requestStartedAt!: Date;

  @Column({ name: 'response_received_at', type: 'timestamptz' })
  responseReceivedAt!: Date;

  @Column({ name: 'stored_at', type: 'timestamptz', default: () => 'clock_timestamp()' })
  storedAt!: Date;

  @ExactNumericColumn({ name: 'last_price' })
  lastPrice!: DValue;

  /** LBank's `lastTime` of the snapshot: its refresh time, NOT the time of the underlying trade. */
  @Column({ name: 'quote_refreshed_at', type: 'timestamptz', nullable: true })
  quoteRefreshedAt!: Date | null;

  @ExactNumericColumn({ name: 'turnover_24h', nullable: true })
  turnover24h!: DValue | null;

  @ExactNumericColumn({ name: 'volume_24h', nullable: true })
  volume24h!: DValue | null;

  /** Failed attempts sent at or after the start before this one (their rows are in the poll log). */
  @Column({ name: 'failed_attempts_before', type: 'integer', default: 0 })
  failedAttemptsBefore!: number;
}

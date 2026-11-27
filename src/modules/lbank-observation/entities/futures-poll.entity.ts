import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { QUOTE_SOURCES, type QuoteSource } from '../futures-quote-rules.js';

/**
 * Each request attempt for LBank's Futures `marketData`: the minute tick, the immediate request at a
 * Review Queue publication, or a prompt retry. `request_started_at` = when the attempt was actually
 * sent, `fetched_at` = when its response (or failure) arrived, `stored_at` = when this row was
 * written; recorded since 2026-11-27 (older rows: tick only, send time not recorded). Failed attempts
 * are rows with `ok = false`. Publication and retry responses keep their raw body (gzip) so every
 * contract's quote can be reconciled later. Proves sampling continuity and its gaps. Immutable.
 */
@Entity({ name: 'lbank_futures_poll' })
@Index('ix_lbank_futures_poll_fetched', ['fetchedAt'])
@Index('ix_lbank_futures_poll_started', ['requestStartedAt'])
@Index('ix_lbank_futures_poll_batch', ['batchId'])
export class FuturesPoll {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  @Column({ name: 'server_at', type: 'timestamptz', nullable: true })
  serverAt!: Date | null;

  @Column({ type: 'boolean' })
  ok!: boolean;

  @Column({ type: 'integer', default: 0 })
  contracts!: number;

  @Column({ type: 'integer', default: 0 })
  stored!: number;

  @Column({ type: 'integer', default: 0 })
  invalid!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'response_sha256', type: 'text', nullable: true })
  responseSha256!: string | null;

  @Column({
    type: 'enum',
    enum: [...QUOTE_SOURCES],
    enumName: 'lbank_fut_request_trigger',
    default: 'TICK',
  })
  trigger!: QuoteSource;

  /** Attempt number inside one request (the HTTP client retries failed attempts). */
  @Column({ type: 'integer', default: 1 })
  attempt!: number;

  /** When our code asked for the request (it may then wait for the client's queue). */
  @Column({ name: 'request_queued_at', type: 'timestamptz', nullable: true })
  requestQueuedAt!: Date | null;

  /** When the attempt was actually sent. */
  @Column({ name: 'request_started_at', type: 'timestamptz', nullable: true })
  requestStartedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  endpoint!: string | null;

  /** The published batch an immediate request (or its retry) was made for. */
  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  /** gzip of the raw response (publication and retry requests only). */
  @Column({ name: 'body_gzip', type: 'bytea', nullable: true })
  bodyGzip!: Buffer | null;

  @Column({
    name: 'stored_at',
    type: 'timestamptz',
    nullable: true,
    default: () => 'clock_timestamp()',
  })
  storedAt!: Date | null;
}

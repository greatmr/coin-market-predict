import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The LBank Spot price request fired together with the Futures quote when a Review Queue is
 * published (`/v2/supplement/ticker/price.do`, every pair in one request; M020): when our code asked
 * for it, when it was actually sent, when its response (or final failure) arrived, every failed
 * attempt, LBank's response time (`ts`, not a trade time) and the raw body. Immutable.
 */
@Entity({ name: 'lbank_spot_price_request' })
@Index('ix_lbank_spot_price_request_batch', ['batchId'])
export class SpotPriceRequest {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @Column({ type: 'text' })
  endpoint!: string;

  @Column({ name: 'request_queued_at', type: 'timestamptz' })
  requestQueuedAt!: Date;

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

  @Column({ name: 'failed_attempts', type: 'jsonb', default: () => "'[]'" })
  failedAttempts!: Array<{ sentAt: string | null; failedAt: string; message: string }>;

  @Column({ name: 'lbank_server_at', type: 'timestamptz', nullable: true })
  lbankServerAt!: Date | null;

  @Column({ type: 'integer', default: 0 })
  pairs!: number;

  @Column({ type: 'integer', default: 0 })
  invalid!: number;

  @Column({ name: 'response_sha256', type: 'text', nullable: true })
  responseSha256!: string | null;

  @Column({ name: 'body_gzip', type: 'bytea', nullable: true })
  bodyGzip!: Buffer | null;
}

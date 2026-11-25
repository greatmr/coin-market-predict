import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CreatedAtColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';

/**
 * An LBank Spot pair whose 1-minute candles are collected (shared by every observation of the pair:
 * overlapping events reuse the same candles). `synced_until` is the exclusive end of the minutes
 * fetched so far: every minute before it was answered by the API (a bar or no bar).
 */
@Entity({ name: 'lbank_spot_pair' })
@Unique('ux_lbank_spot_pair_symbol', ['symbol'])
export class SpotPair {
  @PrimaryGeneratedColumn('identity', { type: 'integer', generatedIdentity: 'ALWAYS' })
  id!: number;

  /** LBank's own symbol, lower case (`0g_usdt`). */
  @Column({ type: 'text' })
  symbol!: string;

  @Column({ type: 'text' })
  base!: string;

  @Column({ type: 'text' })
  quote!: string;

  /** The pair's first 1-minute bar served by the API (listing evidence); null until checked. */
  @Column({ name: 'first_bar_at', type: 'timestamptz', nullable: true })
  firstBarAt!: Date | null;

  @Column({ name: 'synced_until', type: 'timestamptz', nullable: true })
  syncedUntil!: Date | null;

  @Column({ name: 'last_fetch_at', type: 'timestamptz', nullable: true })
  lastFetchAt!: Date | null;

  /** Outcome of the last candle attempt: `ok`, `unsupported` (LBank error 10008) or `error`. */
  @Column({ name: 'last_fetch_status', type: 'text', nullable: true })
  lastFetchStatus!: string | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  /** The last successful candle fetch (`last_fetch_at` is the last attempt). */
  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;

  @Column({ name: 'trades_last_attempt_at', type: 'timestamptz', nullable: true })
  tradesLastAttemptAt!: Date | null;

  @Column({ name: 'trades_last_success_at', type: 'timestamptz', nullable: true })
  tradesLastSuccessAt!: Date | null;

  @Column({ name: 'trades_last_error', type: 'text', nullable: true })
  tradesLastError!: string | null;

  /** First time the API answered "currency pair nonsupport" (cleared when it serves bars again). */
  @Column({ name: 'unsupported_since', type: 'timestamptz', nullable: true })
  unsupportedSince!: Date | null;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

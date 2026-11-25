import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';

import { SpotPair } from './spot-pair.entity.js';

/**
 * The stored 1-minute candles of one pair and UTC day, archived before the raw rows are pruned
 * (docs/lbank-spot-observation.md § 7): a gzip of the canonical CSV `open_ms,open,high,low,close,
 * volume` (exact digits), its SHA-256 and counts. Shared by every observation of the pair, so an
 * overlapping event never duplicates a series. Immutable (trigger). One-minute candles cannot order
 * trades inside a minute: a future stop / target study needs the trades themselves.
 */
@Entity({ name: 'lbank_spot_candle_archive' })
export class CandleArchive {
  @PrimaryColumn({ name: 'pair_id', type: 'integer' })
  pairId!: number;

  @ManyToOne(() => SpotPair, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pair_id' })
  pair?: Relation<SpotPair>;

  @PrimaryColumn({ name: 'utc_date', type: 'date' })
  utcDate!: string;

  @Column({ name: 'first_minute', type: 'timestamptz' })
  firstMinute!: Date;

  @Column({ name: 'last_minute', type: 'timestamptz' })
  lastMinute!: Date;

  @Column({ type: 'integer' })
  bars!: number;

  @Column({ name: 'traded_bars', type: 'integer' })
  tradedBars!: number;

  /** `csv-gzip-v1`. */
  @Column({ type: 'text' })
  encoding!: string;

  @Column({ type: 'bytea' })
  content!: Buffer;

  /** SHA-256 of the uncompressed CSV. */
  @Column({ name: 'content_sha256', type: 'text' })
  contentSha256!: string;

  @Column({ name: 'raw_bytes', type: 'integer' })
  rawBytes!: number;

  @Column({ name: 'archived_at', type: 'timestamptz' })
  archivedAt!: Date;
}

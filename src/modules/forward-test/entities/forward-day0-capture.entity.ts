import { Column, Entity, JoinColumn, ManyToOne, type Relation, Unique } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';
import { CreatedAtColumn } from '../../../common/entities/columns.js';

import { ForwardTestWatchlist } from './forward-test-watchlist.entity.js';

/** One stored hour of a capture: exact source digits and CMC's time of the High. */
export interface StoredHourlyCandle {
  periodStart: string;
  periodEnd: string;
  high: string | null;
  timeHigh: string | null;
  invalidReasons: string[];
}

/**
 * One retrieval of a tracked coin's hourly CMC USD OHLC for one signal date (gap U1,
 * docs/forward-test.md § 6), kept as received: the evaluation decides per event whether it settles
 * the signal day. Immutable and append-only; a later retrieval (e.g. after a daily revision) is a
 * new row, identical responses are stored once.
 */
@Entity({ name: 'forward_day0_capture' })
@Unique('ux_forward_day0_capture', ['providerId', 'cmcId', 'dateUtc', 'responseSha256'])
export class ForwardDay0Capture extends HasBigintId {
  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @ManyToOne(() => ForwardTestWatchlist, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'provider_id', referencedColumnName: 'providerId' },
    { name: 'cmc_id', referencedColumnName: 'cmcId' },
  ])
  watchlist?: Relation<ForwardTestWatchlist>;

  /** The signal date, `YYYY-MM-DD` (UTC). */
  @Column({ name: 'date_utc', type: 'date' })
  dateUtc!: string;

  /** e.g. `cmc_web:/data-api/v3.1/cryptocurrency/historical?interval=1h`. */
  @Column({ type: 'text' })
  source!: string;

  @Column({ type: 'jsonb' })
  params!: Record<string, string>;

  @Column({ name: 'response_sha256', type: 'text' })
  responseSha256!: string;

  @Column({ name: 'retrieved_at', type: 'timestamptz' })
  retrievedAt!: Date;

  /** The date's closed hours as received, in order. */
  @Column({ type: 'jsonb' })
  candles!: StoredHourlyCandle[];

  /** All 24 hours present and valid (whether they match the daily High is decided per use). */
  @Column({ type: 'boolean' })
  complete!: boolean;

  @CreatedAtColumn()
  createdAt!: Date;
}

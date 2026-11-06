import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';

import { Provider } from '../../sources/entities/provider.entity.js';

export const DAILY_FETCH_STATUSES = ['ok', 'partial', 'failed', 'no_data'] as const;
export type DailyFetchStatus = (typeof DAILY_FETCH_STATUSES)[number];

/** Last daily-history request per asset, so a missing day is retried on a schedule, not every run. */
@Entity({ name: 'daily_fetch_state' })
export class DailyFetchState {
  @PrimaryColumn({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @PrimaryColumn({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @Column({ name: 'last_attempt_at', type: 'timestamptz' })
  lastAttemptAt!: Date;

  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;

  @Column({
    name: 'last_status',
    type: 'enum',
    enum: [...DAILY_FETCH_STATUSES],
    enumName: 'daily_fetch_status',
  })
  lastStatus!: DailyFetchStatus;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'rows_returned', type: 'integer', default: 0 })
  rowsReturned!: number;

  /** UTC calendar date, `YYYY-MM-DD`. */
  @Column({ name: 'latest_date_returned', type: 'date', nullable: true })
  latestDateReturned!: string | null;
}

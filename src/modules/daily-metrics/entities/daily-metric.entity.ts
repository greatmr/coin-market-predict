import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
  Unique,
} from 'typeorm';

import { BigintColumn } from '../../../common/entities/bigint.js';
import { TextArrayColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { Provider } from '../../sources/entities/provider.entity.js';

import { DailyMetricRevision } from './daily-metric-revision.entity.js';

/** Effective completed-UTC-day row per asset (PDF p.11); the scan reads these. */
@Entity({ name: 'daily_metric' })
@Unique('ux_daily_metric_revision', ['revisionId'])
export class DailyMetric {
  @PrimaryColumn({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @PrimaryColumn({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  /** UTC calendar date, `YYYY-MM-DD`. */
  @PrimaryColumn({ name: 'date_utc', type: 'date' })
  dateUtc!: string;

  @BigintColumn({ name: 'revision_id' })
  revisionId!: number;

  @ManyToOne(() => DailyMetricRevision, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'revision_id' })
  revisionRow?: Relation<DailyMetricRevision>;

  @Column({ type: 'integer' })
  revision!: number;

  @DecimalColumn(38, 8, { name: 'volume_usd', nullable: true })
  volumeUsd!: DValue | null;

  @DecimalColumn(38, 8, { name: 'market_cap_usd', nullable: true })
  marketCapUsd!: DValue | null;

  @DecimalColumn(38, 18, { name: 'close_usd', nullable: true })
  closeUsd!: DValue | null;

  /** volume / market cap for display (computations use the exact stored inputs). NULL when invalid. */
  @DecimalColumn(65, 30, { nullable: true })
  vmc!: DValue | null;

  @Column({ type: 'boolean' })
  valid!: boolean;

  @TextArrayColumn('invalid_reasons')
  invalidReasons!: string[];

  @Column({ name: 'source_close_at', type: 'timestamptz', nullable: true })
  sourceCloseAt!: Date | null;

  @Column({ name: 'retrieved_at', type: 'timestamptz' })
  retrievedAt!: Date;

  @Column({ type: 'text' })
  source!: string;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

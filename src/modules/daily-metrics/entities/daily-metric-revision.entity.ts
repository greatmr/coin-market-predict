import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation, Unique } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';
import { TextArrayColumn } from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';

/**
 * Every version of one completed UTC day as the source published it (PDF p.11). A new revision is
 * written only when the normalized values change; `daily_metric` points at the effective one.
 */
@Entity({ name: 'daily_metric_revision' })
@Unique('ux_daily_metric_revision_number', ['providerId', 'cmcId', 'dateUtc', 'revision'])
@Index('ix_daily_metric_revision_day', ['providerId', 'cmcId', 'dateUtc'])
export class DailyMetricRevision extends HasBigintId {
  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  /** UTC calendar date, `YYYY-MM-DD`. */
  @Column({ name: 'date_utc', type: 'date' })
  dateUtc!: string;

  @Column({ type: 'integer' })
  revision!: number;

  /** first | source_revision */
  @Column({ name: 'revision_reason', type: 'text' })
  revisionReason!: string;

  @DecimalColumn(38, 8, { name: 'volume_usd', nullable: true })
  volumeUsd!: DValue | null;

  @DecimalColumn(38, 8, { name: 'market_cap_usd', nullable: true })
  marketCapUsd!: DValue | null;

  @DecimalColumn(38, 18, { name: 'open_usd', nullable: true })
  openUsd!: DValue | null;

  @DecimalColumn(38, 18, { name: 'high_usd', nullable: true })
  highUsd!: DValue | null;

  @DecimalColumn(38, 18, { name: 'low_usd', nullable: true })
  lowUsd!: DValue | null;

  @DecimalColumn(38, 18, { name: 'close_usd', nullable: true })
  closeUsd!: DValue | null;

  /**
   * The source's documented time of the day's High / Low (CMC `timeHigh` / `timeLow`). Captured
   * since M008 for the forward test; NULL for rows stored earlier or when the source gives none.
   * Not part of `contentHash`, so capturing it never creates a revision on its own.
   */
  @Column({ name: 'time_high', type: 'timestamptz', nullable: true })
  timeHigh!: Date | null;

  @Column({ name: 'time_low', type: 'timestamptz', nullable: true })
  timeLow!: Date | null;

  @Column({ type: 'boolean' })
  valid!: boolean;

  @TextArrayColumn('invalid_reasons')
  invalidReasons!: string[];

  @Column({ name: 'period_start', type: 'timestamptz', nullable: true })
  periodStart!: Date | null;

  @Column({ name: 'period_end', type: 'timestamptz', nullable: true })
  periodEnd!: Date | null;

  @Column({ name: 'source_close_at', type: 'timestamptz', nullable: true })
  sourceCloseAt!: Date | null;

  /** Exact source text of the fields used. */
  @Column({ name: 'source_fields', type: 'jsonb' })
  sourceFields!: Record<string, unknown>;

  /** cmc_web:<route> | manual_csv_import | fixture:daily */
  @Column({ type: 'text' })
  source!: string;

  @Column({ name: 'source_params', type: 'jsonb' })
  sourceParams!: Record<string, string>;

  @Column({ name: 'response_sha256', type: 'text', nullable: true })
  responseSha256!: string | null;

  @Column({ name: 'content_hash', type: 'text' })
  contentHash!: string;

  @Column({ name: 'retrieved_at', type: 'timestamptz' })
  retrievedAt!: Date;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @ManyToOne(() => CrawlBatch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch> | null;
}

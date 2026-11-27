import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';

/**
 * An operator-approved deletion of an LBank observation cohort (M021, docs § 13c): every observation
 * of the crawl batches up to and including `through_batch_id` was removed from the active dataset;
 * the rows survive only in the recovery backup named here. Immutable.
 */
@Entity({ name: 'lbank_obs_cohort_deletion' })
export class ObsCohortDeletion {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'through_batch_id', type: 'uuid' })
  throughBatchId!: string;

  @ManyToOne(() => CrawlBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'through_batch_id' })
  throughBatch?: Relation<CrawlBatch>;

  @Column({ name: 'through_crawled_at', type: 'timestamptz' })
  throughCrawledAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', default: () => 'clock_timestamp()' })
  deletedAt!: Date;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  counts!: Record<string, unknown>;

  @Column({ type: 'text' })
  backup!: string;
}

/** A crawl batch whose observations were deleted: the intake never reopens it. Immutable. */
@Entity({ name: 'lbank_obs_deleted_batch' })
export class ObsDeletedBatch {
  @PrimaryColumn({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => CrawlBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch>;

  @Column({ name: 'deletion_id', type: 'bigint' })
  deletionId!: string;

  @ManyToOne(() => ObsCohortDeletion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'deletion_id' })
  deletion?: Relation<ObsCohortDeletion>;

  @Column({ type: 'integer' })
  events!: number;
}

/**
 * A deleted event's key (provider, CMC id, UTC date, stars): it stays taken, so a later sighting is
 * ignored exactly as the duplicate of the original event would have been (DB trigger). Immutable.
 */
@Entity({ name: 'lbank_obs_deleted_key' })
export class ObsDeletedKey {
  @PrimaryColumn({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @PrimaryColumn({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @PrimaryColumn({ name: 'detected_utc_date', type: 'date' })
  detectedUtcDate!: string;

  @PrimaryColumn({ name: 'star_count', type: 'integer' })
  starCount!: number;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => ObsDeletedBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  deletedBatch?: Relation<ObsDeletedBatch>;
}

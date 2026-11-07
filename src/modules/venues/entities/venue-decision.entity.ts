import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import { type DecisionKind, VENUE_DECISION_KINDS } from '../../strategy/index.js';

/** Human venue decisions (append-only): LBank tradability verification and mapping evidence. */
@Entity({ name: 'venue_decision' })
@Index('ix_venue_decision_asset', ['providerId', 'cmcId', 'exchange', 'decidedAt'])
export class VenueDecision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  @Column({ type: 'text' })
  exchange!: string;

  /** NULL = applies to the asset on this exchange as a whole (only NOT_TRADABLE). */
  @Column({ name: 'market_pair', type: 'text', nullable: true })
  marketPair!: string | null;

  @Column({ type: 'enum', enum: [...VENUE_DECISION_KINDS], enumName: 'venue_decision_kind' })
  decision!: DecisionKind;

  @Column({ type: 'text' })
  reviewer!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @ManyToOne(() => CrawlBatch, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch> | null;

  @Column({ name: 'decided_at', type: 'timestamptz' })
  decidedAt!: Date;
}

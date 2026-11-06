import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';

import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import {
  CANDLE_STATES,
  type CandleState,
  EVENT_DAYS,
  type EventDay,
  FINAL_DECISIONS,
  type FinalDecision,
  JUDGMENTS,
  type Judgment,
  MARKET_REGIMES,
  type MarketRegime,
  type NormalizedPlan,
  PLAN_STATUSES,
  type PlanStatus,
  VENUE_DECISIONS,
  type VenueReview,
} from '../../strategy/index.js';

/**
 * Human review record (Tier 1 venue/event-day decisions and Tier 2 chart review + trade plan).
 * Append-only: every save is a new revision; earlier decisions are never overwritten (PDF p.16, p.27).
 */
@Entity({ name: 'review' })
@Unique('ux_review_revision', ['providerId', 'cmcId', 'batchId', 'revision'])
@Index('ix_review_asset', ['providerId', 'cmcId', 'reviewedAt'])
export class Review {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  /** Tier 1 crawl batch the review refers to. */
  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => CrawlBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch>;

  @Column({ type: 'integer' })
  revision!: number;

  @Column({ name: 'supersedes_id', type: 'uuid', nullable: true })
  supersedesId!: string | null;

  @ManyToOne(() => Review, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supersedes_id' })
  supersedes?: Relation<Review> | null;

  @Column({ type: 'text' })
  reviewer!: string;

  @Column({ name: 'reviewed_at', type: 'timestamptz' })
  reviewedAt!: Date;

  @Column({
    name: 'venue_decision',
    type: 'enum',
    enum: [...VENUE_DECISIONS],
    enumName: 'venue_review',
  })
  venueDecision!: VenueReview;

  @Column({ name: 'venue_note', type: 'text', nullable: true })
  venueNote!: string | null;

  @Column({ name: 'event_day', type: 'enum', enum: [...EVENT_DAYS], enumName: 'event_day' })
  eventDay!: EventDay;

  @Column({ name: 'lbank_pair', type: 'text', nullable: true })
  lbankPair!: string | null;

  @Column({ name: 'chart_exchange', type: 'text', nullable: true })
  chartExchange!: string | null;

  @Column({ name: 'chart_symbol', type: 'text', nullable: true })
  chartSymbol!: string | null;

  @Column({ name: 'chart_quote', type: 'text', nullable: true })
  chartQuote!: string | null;

  @Column({ name: 'chart_url', type: 'text', nullable: true })
  chartUrl!: string | null;

  @Column({ name: 'chart_timezone', type: 'text', nullable: true })
  chartTimezone!: string | null;

  @Column({ name: 'chart_proxy_reason', type: 'text', nullable: true })
  chartProxyReason!: string | null;

  @Column({ name: 'chart_timestamp', type: 'timestamptz', nullable: true })
  chartTimestamp!: Date | null;

  @Column({
    name: 'range_low',
    type: 'enum',
    enum: [...JUDGMENTS],
    enumName: 'judgment',
    nullable: true,
  })
  rangeLow!: Judgment | null;

  @Column({
    name: 'chart_history',
    type: 'enum',
    enum: [...JUDGMENTS],
    enumName: 'judgment',
    nullable: true,
  })
  chartHistory!: Judgment | null;

  @Column({
    name: 'prior_pump_response',
    type: 'enum',
    enum: [...JUDGMENTS],
    enumName: 'judgment',
    nullable: true,
  })
  priorPumpResponse!: Judgment | null;

  @Column({
    name: 'candle_state',
    type: 'enum',
    enum: [...CANDLE_STATES],
    enumName: 'candle_state',
    nullable: true,
  })
  candleState!: CandleState | null;

  @Column({
    name: 'market_regime',
    type: 'enum',
    enum: [...MARKET_REGIMES],
    enumName: 'market_regime',
    nullable: true,
  })
  marketRegime!: MarketRegime | null;

  @Column({
    name: 'final_decision',
    type: 'enum',
    enum: [...FINAL_DECISIONS],
    enumName: 'final_decision',
  })
  finalDecision!: FinalDecision;

  @Column({ type: 'text', nullable: true })
  rationale!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  plan!: NormalizedPlan | null;

  /** COMPLETE | INCOMPLETE (PLAN_READY only). */
  @Column({
    name: 'plan_status',
    type: 'enum',
    enum: [...PLAN_STATUSES],
    enumName: 'plan_status',
    nullable: true,
  })
  planStatus!: PlanStatus | null;

  @Column({ type: 'jsonb' })
  validation!: { errors: string[]; warnings: string[] };

  /** Copy of the Tier 1 record at review time (inputs, source timestamps, windows, pairs). */
  @Column({ name: 'tier1_snapshot', type: 'jsonb' })
  tier1Snapshot!: Record<string, unknown>;
}

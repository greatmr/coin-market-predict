import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';

import {
  CreatedAtColumn,
  TextArrayColumn,
  UpdatedAtColumn,
} from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import { Provider } from '../../sources/entities/provider.entity.js';
import {
  FUTURES_MAPPING_STATUSES,
  FUTURES_STATUSES,
  type FuturesFoldState,
  type FuturesMappingStatus,
  type FuturesStatus,
} from '../futures-rules.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { Observation } from './observation.entity.js';

/**
 * The LBank Futures side of one observation (rules `lbank-futures-sampled-1`, docs § 13): same event
 * and same proven start as its Spot observation, its own contract, mapping, sampled reference,
 * bounds, coverage, status and rules version. Never written from Spot data; the Spot row is never
 * written from here. Frozen once finalized (trigger).
 */
@Entity({ name: 'lbank_futures_observation' })
@Unique('ux_lbank_futures_observation_obs', ['observationId'])
@Index('ix_lbank_futures_observation_status', ['providerId', 'status'])
@Check(
  'lbank_futures_observation_returns_signed',
  '(highest_return_pct IS NULL OR highest_return_pct >= 0) AND (lowest_return_pct IS NULL OR lowest_return_pct <= 0)',
)
export class FuturesObservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'observation_id', type: 'uuid' })
  observationId!: string;

  @ManyToOne(() => Observation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'observation_id' })
  observation?: Relation<Observation>;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'rules_version', type: 'text' })
  rulesVersion!: string;

  @Column({
    name: 'mapping_status',
    type: 'enum',
    enum: [...FUTURES_MAPPING_STATUSES],
    enumName: 'lbank_fut_mapping_status',
  })
  mappingStatus!: FuturesMappingStatus;

  @Column({ type: 'text', nullable: true })
  contract!: string | null;

  @Column({ name: 'mapping_evidence', type: 'jsonb', default: () => "'{}'" })
  mappingEvidence!: Record<string, unknown>;

  @Column({ type: 'enum', enum: [...FUTURES_STATUSES], enumName: 'lbank_fut_status' })
  status!: FuturesStatus;

  @TextArrayColumn('reasons')
  reasons!: string[];

  @TextArrayColumn('flags')
  flags!: string[];

  /** The running fold over the contract's snapshots (exact decimals as text). */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  fold!: FuturesFoldState | Record<string, never>;

  @ExactNumericColumn({ name: 'reference_price', nullable: true })
  referencePrice!: DValue | null;

  @Column({ name: 'reference_after', type: 'timestamptz', nullable: true })
  referenceAfter!: Date | null;

  @Column({ name: 'reference_before', type: 'timestamptz', nullable: true })
  referenceBefore!: Date | null;

  @ExactNumericColumn({ name: 'highest_price', nullable: true })
  highestPrice!: DValue | null;

  @Column({ name: 'highest_after', type: 'timestamptz', nullable: true })
  highestAfter!: Date | null;

  @Column({ name: 'highest_before', type: 'timestamptz', nullable: true })
  highestBefore!: Date | null;

  @DecimalColumn(65, 30, { name: 'highest_return_pct', nullable: true })
  highestReturnPct!: DValue | null;

  @ExactNumericColumn({ name: 'lowest_price', nullable: true })
  lowestPrice!: DValue | null;

  @Column({ name: 'lowest_after', type: 'timestamptz', nullable: true })
  lowestAfter!: Date | null;

  @Column({ name: 'lowest_before', type: 'timestamptz', nullable: true })
  lowestBefore!: Date | null;

  @DecimalColumn(65, 30, { name: 'lowest_return_pct', nullable: true })
  lowestReturnPct!: DValue | null;

  @Column({ name: 'samples_in_window', type: 'integer', default: 0 })
  samplesInWindow!: number;

  @Column({ name: 'bracketed_in_window', type: 'integer', default: 0 })
  bracketedInWindow!: number;

  @Column({ name: 'max_gap_ms', type: 'bigint', default: 0 })
  maxGapMs!: string;

  /** Latest folded snapshot of the contract (data freshness). */
  @Column({ name: 'sampled_through', type: 'timestamptz', nullable: true })
  sampledThrough!: Date | null;

  @Column({ name: 'last_update_at', type: 'timestamptz', nullable: true })
  lastUpdateAt!: Date | null;

  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

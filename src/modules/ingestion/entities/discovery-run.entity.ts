import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import { Provider } from '../../sources/entities/provider.entity.js';

export const DISCOVERY_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

/** One listing sweep. Only a complete sweep may mark assets delisted. */
@Entity({ name: 'discovery_run' })
@Index('ix_discovery_run_provider_started', ['providerId', 'startedAt'])
export class DiscoveryRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'enum', enum: [...DISCOVERY_STATUSES], enumName: 'discovery_status' })
  status!: DiscoveryStatus;

  @Column({ name: 'pages_fetched', type: 'integer', default: 0 })
  pagesFetched!: number;

  @Column({ name: 'assets_seen', type: 'integer', default: 0 })
  assetsSeen!: number;

  @Column({ name: 'new_assets', type: 'integer', default: 0 })
  newAssets!: number;

  @Column({ name: 'delisted_assets', type: 'integer', default: 0 })
  delistedAssets!: number;

  /** Total the source reports it lists, when the source exposes it. NULL means unknown. */
  @Column({ name: 'source_total', type: 'integer', nullable: true })
  sourceTotal!: number | null;

  /** True only when the sweep fetched every page the source offers. */
  @Column({ name: 'coverage_complete', type: 'boolean', default: false })
  coverageComplete!: boolean;

  @Column({ name: 'requests_used', type: 'integer', default: 0 })
  requestsUsed!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  notes!: unknown;
}

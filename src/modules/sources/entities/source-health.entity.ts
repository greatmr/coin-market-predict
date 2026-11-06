import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';

import { UpdatedAtColumn } from '../../../common/entities/columns.js';

import { CIRCUIT_STATES, type CircuitState } from '../http/source-health.js';

import { Provider } from './provider.entity.js';

/** Circuit-breaker and request-budget state per provider (survives restarts). */
@Entity({ name: 'source_health' })
export class SourceHealth {
  @PrimaryColumn({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ type: 'enum', enum: [...CIRCUIT_STATES], enumName: 'circuit_state', default: 'closed' })
  state!: CircuitState;

  @Column({ name: 'consecutive_failures', type: 'integer', default: 0 })
  consecutiveFailures!: number;

  @Column({ name: 'consecutive_denials', type: 'integer', default: 0 })
  consecutiveDenials!: number;

  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt!: Date | null;

  @Column({ name: 'retry_after_until', type: 'timestamptz', nullable: true })
  retryAfterUntil!: Date | null;

  @Column({ name: 'suspended_reason', type: 'text', nullable: true })
  suspendedReason!: string | null;

  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;

  @Column({ name: 'last_failure_at', type: 'timestamptz', nullable: true })
  lastFailureAt!: Date | null;

  @Column({ name: 'last_status_code', type: 'integer', nullable: true })
  lastStatusCode!: number | null;

  @Column({ name: 'budget_period_start', type: 'timestamptz', nullable: true })
  budgetPeriodStart!: Date | null;

  @Column({ name: 'budget_used', type: 'integer', default: 0 })
  budgetUsed!: number;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

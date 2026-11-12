import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import { TextArrayColumn } from '../../../common/entities/columns.js';

import { AppUser } from '../../auth/entities/app-user.entity.js';
import { CrawlBatch } from '../../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../../sources/entities/provider.entity.js';
import type { AgentUsage } from '../agent-runner.js';
import type { ToolCallRecord } from '../agent-tools.js';
import {
  AGENT_CONFIDENCES,
  AGENT_OUTLOOKS,
  AGENT_RUN_STATUSES,
  type AgentConfidence,
  type AgentOutlook,
  type AgentRunStatus,
} from '../agent.constants.js';
import type { CoinAnalysis } from '../agent.schemas.js';

/**
 * One run of the Claude coin agent (docs/adr/0005-coin-agent.md): who asked, about which coin and
 * Tier 1 batch, with which model and instructions, what the tools returned, and the agent's view.
 * History: a row is written when the run starts and completed once; a database trigger (M010)
 * keeps a finished analysis immutable. Stored source data is never changed by an analysis.
 */
@Entity({ name: 'agent_analysis' })
@Index('ix_agent_analysis_coin', ['providerId', 'cmcId', 'requestedAt'])
@Index('ix_agent_analysis_requested', ['requestedAt'])
@Check('agent_analysis_finished_consistent', `(status = 'RUNNING') = (finished_at IS NULL)`)
@Check(
  'agent_analysis_success_has_output',
  `status <> 'SUCCEEDED' OR (output IS NOT NULL AND outlook IS NOT NULL AND confidence IS NOT NULL)`,
)
export class AgentAnalysis {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  @Column({ name: 'cmc_id', type: 'integer' })
  cmcId!: number;

  /** Symbol and name as stored for the record (untrusted source text). */
  @Column({ type: 'text' })
  symbol!: string;

  @Column({ type: 'text' })
  name!: string;

  /** Crawl batch of the Tier 1 record the agent read. */
  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => CrawlBatch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'batch_id' })
  batch?: Relation<CrawlBatch>;

  /** false = synthetic fixture data. */
  @Column({ name: 'is_live', type: 'boolean' })
  isLive!: boolean;

  /** Username at the time of the request (kept when the account is deleted). */
  @Column({ name: 'requested_by', type: 'text' })
  requestedBy!: string;

  @Column({ name: 'requested_by_id', type: 'uuid', nullable: true })
  requestedById!: string | null;

  @ManyToOne(() => AppUser, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'requested_by_id' })
  requestedByUser?: Relation<AppUser> | null;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'enum', enum: [...AGENT_RUN_STATUSES], enumName: 'agent_run_status' })
  status!: AgentRunStatus;

  /** Counts toward AGENT_MAX_RUNS per AGENT_WINDOW_HOURS (false: failed before Claude answered). */
  @Column({ name: 'counts_toward_limit', type: 'boolean', default: true })
  countsTowardLimit!: boolean;

  @Column({ type: 'text' })
  model!: string;

  @Column({ name: 'fallback_model', type: 'text', nullable: true })
  fallbackModel!: string | null;

  @Column({ type: 'text' })
  effort!: string;

  @Column({ name: 'prompt_version', type: 'text' })
  promptVersion!: string;

  @Column({ name: 'ruleset_version', type: 'text' })
  rulesetVersion!: string;

  @Column({
    type: 'enum',
    enum: [...AGENT_OUTLOOKS],
    enumName: 'agent_outlook',
    nullable: true,
  })
  outlook!: AgentOutlook | null;

  @Column({
    type: 'enum',
    enum: [...AGENT_CONFIDENCES],
    enumName: 'agent_confidence',
    nullable: true,
  })
  confidence!: AgentConfidence | null;

  /** The validated structured answer, after the confidence guardrails. */
  @Column({ type: 'jsonb', nullable: true })
  output!: CoinAnalysis | null;

  /** Deterministic adjustments applied to the answer (`guardrails.ts`). */
  @TextArrayColumn('guardrail_notes')
  guardrailNotes!: string[];

  /** Every tool call with its input and output (what the agent saw), plus refused calls. */
  @Column({ name: 'tool_calls', type: 'jsonb' })
  toolCalls!: Array<ToolCallRecord | { name: string; denied: true }>;

  /** Tokens, the SDK's cost estimate, turns, duration and the models that answered. */
  @Column({ type: 'jsonb', nullable: true })
  usage!: AgentUsage | null;

  @Column({ name: 'error_kind', type: 'text', nullable: true })
  errorKind!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;
}

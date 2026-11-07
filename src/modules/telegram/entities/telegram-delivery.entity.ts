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

import { CreatedAtColumn } from '../../../common/entities/columns.js';

import { PipelineRun } from '../../pipeline/entities/pipeline-run.entity.js';

export const DELIVERY_MODES = ['live', 'dry_run'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'dry_run'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * One report part for one chat. (report hash, part, chat) suppresses duplicates; delivery retries
 * run on their own schedule and never re-run collection or analysis.
 */
@Entity({ name: 'telegram_delivery' })
@Unique('ux_telegram_delivery_part', ['reportHash', 'partIndex', 'chatId'])
@Index('ix_telegram_delivery_due', ['status', 'nextAttemptAt'])
export class TelegramDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId!: string;

  @ManyToOne(() => PipelineRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: Relation<PipelineRun>;

  /** Hash of the report content; with partIndex and chatId it suppresses duplicates. */
  @Column({ name: 'report_hash', type: 'text' })
  reportHash!: string;

  @Column({ name: 'part_index', type: 'integer' })
  partIndex!: number;

  @Column({ name: 'part_count', type: 'integer' })
  partCount!: number;

  @Column({ name: 'chat_id', type: 'text' })
  chatId!: string;

  @Column({ type: 'enum', enum: [...DELIVERY_MODES], enumName: 'telegram_delivery_mode' })
  mode!: DeliveryMode;

  @Column({ type: 'enum', enum: [...DELIVERY_STATUSES], enumName: 'telegram_delivery_status' })
  status!: DeliveryStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'telegram_message_id', type: 'text', nullable: true })
  telegramMessageId!: string | null;

  @Column({ type: 'text' })
  text!: string;

  @CreatedAtColumn()
  createdAt!: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;
}

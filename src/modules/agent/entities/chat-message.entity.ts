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

import type { AgentUsage } from '../agent-runner.js';
import type { ChatToolCall } from '../chat/chat-tools.js';
import {
  CHAT_MESSAGE_STATUSES,
  CHAT_ROLES,
  type ChatMessageStatus,
  type ChatRole,
} from '../chat/chat.constants.js';

import { ChatConversation } from './chat-conversation.entity.js';

/**
 * A message of a conversation: the owner's (`user`, always DONE) or the desk's reply
 * (`assistant`: RUNNING while Claude works, then DONE or FAILED). A user message counts toward the
 * limit unless its reply failed before Claude answered.
 */
@Entity({ name: 'chat_message' })
@Index('ix_chat_message_conversation', ['conversationId', 'seq'], { unique: true })
@Check('chat_message_user_done', `role <> 'user' OR status = 'DONE'`)
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @ManyToOne('ChatConversation', 'messages', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation?: Relation<ChatConversation>;

  @Column({ type: 'integer' })
  seq!: number;

  @Column({ type: 'enum', enum: [...CHAT_ROLES], enumName: 'chat_role' })
  role!: ChatRole;

  @Column({
    type: 'enum',
    enum: [...CHAT_MESSAGE_STATUSES],
    enumName: 'chat_message_status',
  })
  status!: ChatMessageStatus;

  @Column({ type: 'text' })
  content!: string;

  /** Model and effort the reply was requested with (on both the user's message and the reply). */
  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'text', nullable: true })
  effort!: string | null;

  @Column({ name: 'prompt_version', type: 'text', nullable: true })
  promptVersion!: string | null;

  /** Strategy fingerprint the reply was written under. */
  @Column({ name: 'strategy_version', type: 'text', nullable: true })
  strategyVersion!: string | null;

  @Column({ name: 'counts_toward_limit', type: 'boolean', default: true })
  countsTowardLimit!: boolean;

  @Column({ name: 'tool_calls', type: 'jsonb', default: () => `'[]'` })
  toolCalls!: ChatToolCall[];

  @Column({ type: 'jsonb', nullable: true })
  usage!: AgentUsage | null;

  @Column({ name: 'error_kind', type: 'text', nullable: true })
  errorKind!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}

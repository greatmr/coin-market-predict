import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import { AppUser } from '../../auth/entities/app-user.entity.js';

import type { ChatMessage } from './chat-message.entity.js';

/** One owner conversation with the Claude analyst desk (docs/adr/0012-owner-chat.md). */
@Entity({ name: 'chat_conversation' })
@Index('ix_chat_conversation_owner', ['ownerId', 'updatedAt'])
export class ChatConversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_id', type: 'uuid', nullable: true })
  ownerId!: string | null;

  @ManyToOne(() => AppUser, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'owner_id' })
  owner?: Relation<AppUser> | null;

  /** Username at creation (kept when the account is deleted). */
  @Column({ name: 'owner_name', type: 'text' })
  ownerName!: string;

  @Column({ type: 'text' })
  title!: string;

  /** Strategy fingerprint when the conversation began; a different current one is shown as an update. */
  @Column({ name: 'strategy_version', type: 'text' })
  strategyVersion!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany('ChatMessage', 'conversation')
  messages?: Relation<ChatMessage[]>;
}

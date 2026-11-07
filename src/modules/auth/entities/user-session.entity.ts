import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';

import { CreatedAtColumn } from '../../../common/entities/columns.js';

import { AppUser } from './app-user.entity.js';

/**
 * A signed-in browser. The cookie carries a random token; only its SHA-256 is stored, so a leaked
 * database row cannot be replayed as a session. Deleting the user ends its sessions.
 */
@Entity({ name: 'user_session' })
@Index('ix_user_session_user', ['userId'])
export class UserSession {
  /** SHA-256 (hex) of the cookie token. */
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => AppUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: Relation<AppUser>;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz', default: () => 'now()' })
  lastSeenAt!: Date;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'text', nullable: true })
  ip!: string | null;

  @CreatedAtColumn()
  createdAt!: Date;
}

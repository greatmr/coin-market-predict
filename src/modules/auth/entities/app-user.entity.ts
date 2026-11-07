import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CreatedAtColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';

import { USER_ROLES, type UserRole } from '../permissions.js';

/**
 * A dashboard login. Usernames are stored lowercase (unique, so case-insensitively unique); only
 * the scrypt hash of the password is kept. Never exposed through the API as a whole row.
 */
@Entity({ name: 'app_user' })
@Unique('app_user_username_key', ['username'])
export class AppUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  username!: string;

  @Column({ type: 'enum', enum: [...USER_ROLES], enumName: 'user_role' })
  role!: UserRole;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  /** Set for the bootstrap owner and for passwords an owner reset: the next login must choose a new one. */
  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword!: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /** Consecutive failed logins; reaching the limit locks the account until `lockedUntil`. */
  @Column({ name: 'failed_logins', type: 'integer', default: 0 })
  failedLogins!: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @Column({ name: 'password_changed_at', type: 'timestamptz', default: () => 'now()' })
  passwordChangedAt!: Date;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

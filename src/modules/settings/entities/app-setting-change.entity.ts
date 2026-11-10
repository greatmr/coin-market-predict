import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';

import { HasBigintId } from '../../../common/entities/bigint.js';

import type { SettingValue } from '../../../config/settings.catalog.js';

import { AppUser } from '../../auth/entities/app-user.entity.js';
import { SETTING_CHANGE_SOURCES, type SettingChangeSource } from '../settings.constants.js';

/**
 * Append-only history of dashboard settings (a database trigger refuses edits and deletions): every
 * save, reset and import, the value before and after (null = not set in the dashboard), and who
 * made it. The name is kept when the user is later deleted.
 */
@Entity({ name: 'app_setting_change' })
@Index('ix_app_setting_change_changed_at', ['changedAt'])
export class AppSettingChange extends HasBigintId {
  @Column({ type: 'text' })
  key!: string;

  @Column({ name: 'old_value', type: 'jsonb', nullable: true })
  oldValue!: SettingValue | null;

  @Column({ name: 'new_value', type: 'jsonb', nullable: true })
  newValue!: SettingValue | null;

  @Column({
    type: 'enum',
    enum: [...SETTING_CHANGE_SOURCES],
    enumName: 'setting_change_source',
  })
  source!: SettingChangeSource;

  @Column({ name: 'changed_by', type: 'uuid', nullable: true })
  changedBy!: string | null;

  @ManyToOne(() => AppUser, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'changed_by' })
  changer?: Relation<AppUser> | null;

  @Column({ name: 'changed_by_name', type: 'text' })
  changedByName!: string;

  @Column({ name: 'changed_at', type: 'timestamptz', default: () => 'now()' })
  changedAt!: Date;
}

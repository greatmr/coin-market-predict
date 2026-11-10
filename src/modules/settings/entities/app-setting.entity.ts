import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';

import { UpdatedAtColumn } from '../../../common/entities/columns.js';

import type { SettingValue } from '../../../config/settings.catalog.js';

import { AppUser } from '../../auth/entities/app-user.entity.js';

/**
 * One dashboard setting an owner saved (`config/settings.catalog.ts`). No row means the environment
 * or the default applies. Every change is also recorded in `app_setting_change`.
 */
@Entity({ name: 'app_setting' })
@Check('app_setting_value_scalar', `jsonb_typeof(value) IN ('string', 'number', 'boolean')`)
export class AppSetting {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'jsonb' })
  value!: SettingValue;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @ManyToOne(() => AppUser, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by' })
  updater?: Relation<AppUser> | null;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

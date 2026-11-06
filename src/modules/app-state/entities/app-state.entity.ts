import { Column, Entity, PrimaryColumn } from 'typeorm';

import { UpdatedAtColumn } from '../../../common/entities/columns.js';

/**
 * Small key/value store for durable application state: Telegram access list and bot offset, the
 * retention watermark, the fixture market's anchor date. Never market data.
 */
@Entity({ name: 'app_state' })
export class AppState {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'jsonb' })
  value!: unknown;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

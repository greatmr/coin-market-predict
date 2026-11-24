import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';

import { CreatedAtColumn, UpdatedAtColumn } from '../../../common/entities/columns.js';

import { Provider } from '../../sources/entities/provider.entity.js';

/**
 * The persisted cutover between the legacy Star Event Forward Test and the LBank Spot Price
 * Observation (docs/adr/0009-lbank-spot-observation.md): one row per provider. Sightings detected
 * before `cutover_at` stay legacy events (`forward_event`); at or after it they become LBank
 * observation events (`lbank_obs_event`). Database triggers refuse an event in the wrong tracker and
 * any change to a cutover that has passed (migration M015).
 */
@Entity({ name: 'signal_cutover' })
@Check('signal_cutover_utc_midnight', 'mod(extract(epoch FROM cutover_at), 86400) = 0')
export class SignalCutover {
  @PrimaryColumn({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider?: Relation<Provider>;

  /** Exactly 00:00:00.000 UTC, so no event key (it contains the UTC date) straddles both trackers. */
  @Column({ name: 'cutover_at', type: 'timestamptz' })
  cutoverAt!: Date;

  @Column({ name: 'set_at', type: 'timestamptz' })
  setAt!: Date;

  @Column({ name: 'set_by', type: 'text' })
  setBy!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

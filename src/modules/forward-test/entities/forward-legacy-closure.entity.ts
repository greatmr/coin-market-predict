import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';

import {
  CreatedAtColumn,
  TextArrayColumn,
  UpdatedAtColumn,
} from '../../../common/entities/columns.js';
import { DecimalColumn } from '../../../common/entities/decimal.transformer.js';
import type { DValue } from '../../../common/utils/decimal.js';

import {
  FORWARD_EVENT_STATUSES,
  type ForwardEventStatus,
  PEAK_KINDS,
  type PeakKind,
} from '../forward.constants.js';
import { LEGACY_CLOSURES, type LegacyClosure } from '../legacy-closure.js';

import { ForwardEvent } from './forward-event.entity.js';

/**
 * The explicit terminal outcome of a legacy (pre-cutover) forward-test event (`legacy-closure.ts`):
 * FINAL, INCOMPLETE (a lower bound) or DATA_UNAVAILABLE, with the reasons and the outcome version it
 * rests on. Written by the daily update while the legacy tracker runs; the event and its outcomes
 * are never changed by it. Frozen once the legacy tracker is retired.
 */
@Entity({ name: 'forward_legacy_closure' })
export class ForwardLegacyClosure {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => ForwardEvent, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event?: Relation<ForwardEvent>;

  @Column({
    type: 'enum',
    enum: [...LEGACY_CLOSURES],
    enumName: 'forward_legacy_closure_kind',
  })
  closure!: LegacyClosure;

  /** The event's status when it was closed. */
  @Column({
    name: 'status_at_closure',
    type: 'enum',
    enum: [...FORWARD_EVENT_STATUSES],
    enumName: 'forward_event_status',
  })
  statusAtClosure!: ForwardEventStatus;

  /** The `forward_outcome.result_version` the closure rests on (0 = no outcome). */
  @Column({ name: 'outcome_version', type: 'integer' })
  outcomeVersion!: number;

  @Column({
    name: 'peak_kind',
    type: 'enum',
    enum: [...PEAK_KINDS],
    enumName: 'forward_peak_kind',
    nullable: true,
  })
  peakKind!: PeakKind | null;

  @DecimalColumn(65, 30, { name: 'peak_return_pct', nullable: true })
  peakReturnPct!: DValue | null;

  @TextArrayColumn('reasons')
  reasons!: string[];

  @Column({ name: 'closed_at', type: 'timestamptz' })
  closedAt!: Date;

  @Column({ name: 'rules_version', type: 'text' })
  rulesVersion!: string;

  @CreatedAtColumn()
  createdAt!: Date;

  @UpdatedAtColumn()
  updatedAt!: Date;
}

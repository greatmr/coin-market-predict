import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';

import type { DValue } from '../../../common/utils/decimal.js';

import { ExactNumericColumn } from './exact-numeric.js';
import { Observation } from './observation.entity.js';
import { SpotPriceRequest } from './spot-price-request.entity.js';

/**
 * An indicative LBank Spot quote at publication (M020): the pair's latest price in the Spot price
 * request fired with the Futures quote, with that request's times. Context for a same-moment
 * Spot / Futures comparison only — never the Spot reference (the first verified trade at or after the
 * start), never a Spot return or extreme, and not a trade time (LBank's response has none per pair).
 * Immutable; one per observation.
 */
@Entity({ name: 'lbank_spot_indicative_quote' })
@Unique('ux_lbank_spot_indicative_quote_observation', ['observationId'])
@Check('lbank_spot_indicative_quote_price_positive', 'price > 0')
@Check('lbank_spot_indicative_quote_sent_after_start', 'request_started_at >= actionable_start')
@Check(
  'lbank_spot_indicative_quote_received_after_sent',
  'response_received_at >= request_started_at',
)
export class SpotIndicativeQuote {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'observation_id', type: 'uuid' })
  observationId!: string;

  @ManyToOne(() => Observation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'observation_id' })
  observation?: Relation<Observation>;

  @Column({ name: 'request_id', type: 'bigint' })
  requestId!: string;

  @ManyToOne(() => SpotPriceRequest, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'request_id' })
  request?: Relation<SpotPriceRequest>;

  @Column({ name: 'pair_symbol', type: 'text' })
  pairSymbol!: string;

  @Column({ name: 'actionable_start', type: 'timestamptz' })
  actionableStart!: Date;

  @ExactNumericColumn({ name: 'price' })
  price!: DValue;

  @Column({ name: 'request_queued_at', type: 'timestamptz' })
  requestQueuedAt!: Date;

  @Column({ name: 'request_started_at', type: 'timestamptz' })
  requestStartedAt!: Date;

  @Column({ name: 'response_received_at', type: 'timestamptz' })
  responseReceivedAt!: Date;

  @Column({ name: 'lbank_server_at', type: 'timestamptz', nullable: true })
  lbankServerAt!: Date | null;

  @Column({ name: 'stored_at', type: 'timestamptz', default: () => 'clock_timestamp()' })
  storedAt!: Date;
}

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Each read of LBank's Futures `marketData` by the sampler: when, whether it worked, the snapshot's
 * own time (the latest `lastTime`), how many contracts it held and how many rows were stored. Proves
 * sampling continuity (and its gaps) independently of any one contract.
 */
@Entity({ name: 'lbank_futures_poll' })
@Index('ix_lbank_futures_poll_fetched', ['fetchedAt'])
export class FuturesPoll {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  @Column({ name: 'server_at', type: 'timestamptz', nullable: true })
  serverAt!: Date | null;

  @Column({ type: 'boolean' })
  ok!: boolean;

  @Column({ type: 'integer', default: 0 })
  contracts!: number;

  @Column({ type: 'integer', default: 0 })
  stored!: number;

  @Column({ type: 'integer', default: 0 })
  invalid!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'response_sha256', type: 'text', nullable: true })
  responseSha256!: string | null;
}

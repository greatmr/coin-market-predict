import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Database-backed lease: prevents overlapping runs across application instances (`LeaseService`). */
@Entity({ name: 'job_lease' })
export class JobLease {
  @PrimaryColumn({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  holder!: string;

  @Column({ name: 'acquired_at', type: 'timestamptz' })
  acquiredAt!: Date;

  @Column({ name: 'heartbeat_at', type: 'timestamptz' })
  heartbeatAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}

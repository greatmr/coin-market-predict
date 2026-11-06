import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

/**
 * Database-backed lease (`job_lease`). Acquisition is a single atomic upsert evaluated with the
 * database clock, so two application instances can never both hold the same lease.
 */
@Injectable()
export class LeaseService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async acquire(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const rows = (await this.db.query(
      `INSERT INTO job_lease (name, holder, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, now(), now(), now() + make_interval(secs => $3))
       ON CONFLICT (name) DO UPDATE
         SET holder = EXCLUDED.holder,
             acquired_at = CASE WHEN job_lease.holder = EXCLUDED.holder THEN job_lease.acquired_at ELSE EXCLUDED.acquired_at END,
             heartbeat_at = EXCLUDED.heartbeat_at,
             expires_at = EXCLUDED.expires_at
         WHERE job_lease.expires_at < now() OR job_lease.holder = EXCLUDED.holder
       RETURNING holder`,
      [name, holder, ttlMs / 1000],
    )) as Array<{ holder: string }>;
    return rows.length === 1 && rows[0]!.holder === holder;
  }

  async heartbeat(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const [, updated] = (await this.db.query(
      `UPDATE job_lease SET heartbeat_at = now(), expires_at = now() + make_interval(secs => $3) WHERE name = $1 AND holder = $2`,
      [name, holder, ttlMs / 1000],
    )) as [unknown, number];
    return updated === 1;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.db.query(`DELETE FROM job_lease WHERE name = $1 AND holder = $2`, [name, holder]);
  }
}

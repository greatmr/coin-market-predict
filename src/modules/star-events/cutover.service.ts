import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';

import { SignalCutover } from './entities/signal-cutover.entity.js';
import { type SignalWorkflow, cutoverProblem, workflowFor } from './star-event.rules.js';

/** A cutover must be set at least this far ahead (one hourly run plus margin). */
export const CUTOVER_MIN_LEAD_MS = 2 * 3_600_000;

export interface CutoverStatus {
  providerId: string;
  cutoverAt: string | null;
  setAt: string | null;
  setBy: string | null;
  note: string | null;
  /** The cutover time has been reached: new sightings go to the LBank observation. */
  passed: boolean;
}

export class CutoverError extends Error {}

/**
 * Reads and sets the persisted cutover between the legacy forward test and the LBank observation.
 * Routing is a pure function of the cutover and a sighting's detection time (`workflowFor`), and a
 * cutover can only be set ahead of every stored batch, so no batch ever changes tracker.
 */
@Injectable()
export class CutoverService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async get(providerId: string): Promise<Date | null> {
    const row = await this.db.getRepository(SignalCutover).findOneBy({ providerId });
    return row?.cutoverAt ?? null;
  }

  async route(providerId: string, detectedAt: Date): Promise<SignalWorkflow> {
    return workflowFor(await this.get(providerId), detectedAt);
  }

  async status(providerId: string, now: Date): Promise<CutoverStatus> {
    const row = await this.db.getRepository(SignalCutover).findOneBy({ providerId });
    return {
      providerId,
      cutoverAt: row?.cutoverAt.toISOString() ?? null,
      setAt: row?.setAt.toISOString() ?? null,
      setBy: row?.setBy ?? null,
      note: row?.note ?? null,
      passed: !!row && row.cutoverAt.getTime() <= now.getTime(),
    };
  }

  /**
   * Persist the cutover (operator action, CLI `observation:cutover`). Refused unless it is a UTC
   * midnight at least CUTOVER_MIN_LEAD_MS ahead and after every stored crawl batch; an existing
   * cutover can be moved only while it is still that far ahead.
   */
  async set(
    providerId: string,
    requested: Date,
    opts: { now: Date; setBy: string; note?: string | null },
  ): Promise<CutoverStatus> {
    await this.db.transaction(async (m) => {
      // Serialize concurrent setters on the provider row's cutover.
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('signal_cutover:' || $1))`, [
        providerId,
      ]);
      const current = await m.getRepository(SignalCutover).findOneBy({ providerId });
      const latest = await m.getRepository(CrawlBatch).findOne({
        where: { providerId },
        order: { crawledAt: 'DESC' },
        select: { id: true, crawledAt: true },
      });
      const problem = cutoverProblem({
        requested,
        current: current?.cutoverAt ?? null,
        now: opts.now,
        latestBatchCrawledAt: latest?.crawledAt ?? null,
        minLeadMs: CUTOVER_MIN_LEAD_MS,
      });
      if (problem) throw new CutoverError(problem);
      await m.getRepository(SignalCutover).upsert(
        {
          providerId,
          cutoverAt: requested,
          setAt: opts.now,
          setBy: opts.setBy,
          note: opts.note ?? null,
        },
        ['providerId'],
      );
    });
    return this.status(providerId, opts.now);
  }
}

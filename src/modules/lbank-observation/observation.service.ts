import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DataSource } from 'typeorm';

import { redact } from '../../common/security/redact.js';
import { type Clock, systemClock } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { LeaseService } from '../pipeline/lease.service.js';
import { CutoverService } from '../star-events/cutover.service.js';

import { type ObsRunReport, ObservationUpdateService } from './observation-update.service.js';
import { CLOSED_BAR_MARGIN_MS, MINUTE_MS } from './observation.constants.js';

export const OBSERVATION_LEASE = 'lbank-observation';
const LEASE_TTL_MS = 15 * 60_000;
const CRON_NAME = 'lbank-observation';
/**
 * Follow-up runs (processing latency, not a rule): a new observation's reference can be verified as
 * soon as its start minute has closed (candle final + CLOSED_BAR_MARGIN_MS), so the job runs then
 * instead of at the next cron tick, and again every FOLLOW_UP_MS while a start younger than
 * FOLLOW_UP_HORIZON_MS still has no reference (no trade yet, an open minute, a failed request).
 * Measured before (2026-11-25, SOLV): start 16:07:06.894, trade +0.660 s, first check 16:15:00.
 */
export const FOLLOW_UP_MS = 60_000;
export const FOLLOW_UP_HORIZON_MS = 60 * 60_000;
const FOLLOW_UP_SLACK_MS = 1_000;

export type ObsRunTrigger = 'schedule' | 'manual' | 'cli' | 'follow-up';

/**
 * Entry point of the observation job for the scheduler, the CLI and the dashboard: one run at a
 * time across instances (its own database lease, independent of the CMC pipeline's), so a slow
 * LBank never delays the hourly CMC run and vice versa.
 */
@Injectable()
export class ObservationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(ObservationService.name);
  clock: Clock = systemClock;
  private running = false;
  private followTimer: NodeJS.Timeout | null = null;
  private followAt: number | null = null;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly registry: SchedulerRegistry,
    private readonly leases: LeaseService,
    private readonly updates: ObservationUpdateService,
    private readonly cutover: CutoverService,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  onApplicationBootstrap() {
    if (!this.cfg.SCHEDULER_ENABLED || !this.cfg.LBANK_OBSERVATION_ENABLED) return;
    const job = CronJob.from({
      cronTime: this.cfg.LBANK_OBSERVATION_CRON,
      timeZone: 'UTC',
      onTick: () => void this.tick(),
      start: true,
    });
    this.registry.addCronJob(CRON_NAME, job);
    this.log.log(
      `LBank observation job "${this.cfg.LBANK_OBSERVATION_CRON}" UTC, next ${job.nextDate().toISO()}`,
    );
  }

  onApplicationShutdown() {
    if (this.registry.doesExist('cron', CRON_NAME)) void this.registry.getCronJob(CRON_NAME).stop();
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
    this.followAt = null;
  }

  private get followUpsEnabled() {
    return this.cfg.SCHEDULER_ENABLED && this.cfg.LBANK_OBSERVATION_ENABLED;
  }

  /**
   * The earliest moment a follow-up run can verify a pending reference: the close of the earliest
   * pending start minute (plus the closed-bar margin), or one FOLLOW_UP_MS from now when that
   * minute has closed already. Null when no young observation awaits its reference.
   */
  async nextFollowUpAt(nowMs: number): Promise<number | null> {
    const rows: Array<{ start: Date | null }> = await this.db.query(
      `SELECT min(observation_start) AS start FROM lbank_observation
        WHERE provider_id = $1 AND finalized_at IS NULL AND reference_status = 'PENDING'
          AND observation_start IS NOT NULL AND observation_start > $2`,
      [this.providerId, new Date(nowMs - FOLLOW_UP_HORIZON_MS)],
    );
    const start = rows[0]?.start ? new Date(rows[0].start).getTime() : null;
    if (start === null) return null;
    const closes =
      Math.floor(start / MINUTE_MS) * MINUTE_MS +
      MINUTE_MS +
      CLOSED_BAR_MARGIN_MS +
      FOLLOW_UP_SLACK_MS;
    return closes > nowMs ? closes : nowMs + FOLLOW_UP_MS;
  }

  /** Called after the intake opened observations (pipeline `observe` stage) and after every run. */
  async nudge(): Promise<void> {
    if (!this.followUpsEnabled) return;
    const at = await this.nextFollowUpAt(this.clock.now().getTime());
    if (at !== null) this.followUpAt(at);
  }

  private followUpAt(at: number) {
    // Keep the earliest timer; a later need is re-checked after that run.
    if (this.followAt !== null && this.followAt <= at) return;
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followAt = at;
    this.followTimer = setTimeout(
      () => {
        this.followTimer = null;
        this.followAt = null;
        void this.followUp();
      },
      Math.max(0, at - Date.now()),
    );
    this.followTimer.unref?.();
  }

  private async followUp() {
    try {
      const r = await this.runNow('follow-up');
      // Skipped (another run holds the lease): look again after it.
      if ('skipped' in r) this.followUpAt(Date.now() + FOLLOW_UP_MS);
    } catch (err) {
      this.log.error(`LBank observation follow-up run failed: ${redact(err)}`);
      this.followUpAt(Date.now() + FOLLOW_UP_MS);
    }
  }

  private async tick() {
    try {
      // Nothing can be observed before a cutover exists: no run row every 15 minutes until then.
      if (!(await this.cutover.get(this.providerId))) return;
      const r = await this.runNow('schedule');
      if ('skipped' in r) this.log.log(`LBank observation run skipped: ${r.skipped}`);
    } catch (err) {
      this.log.error(`LBank observation run failed: ${redact(err)}`);
    }
  }

  /** One run now under the observation lease (skipped when another run holds it). */
  async runNow(trigger: ObsRunTrigger): Promise<ObsRunReport | { skipped: string }> {
    if (this.running) return { skipped: 'a run is already in progress in this process' };
    const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    if (!(await this.leases.acquire(OBSERVATION_LEASE, holder, LEASE_TTL_MS)))
      return { skipped: 'another instance holds the observation lease' };
    this.running = true;
    const beat = setInterval(
      () =>
        void this.leases.heartbeat(OBSERVATION_LEASE, holder, LEASE_TTL_MS).catch(() => undefined),
      60_000,
    );
    try {
      return await this.updates.run(this.providerId, { now: this.clock.now(), trigger });
    } finally {
      clearInterval(beat);
      this.running = false;
      await this.leases.release(OBSERVATION_LEASE, holder).catch(() => undefined);
      if (trigger !== 'cli') await this.nudge().catch(() => undefined);
    }
  }

  /** Dashboard: start a run in the background; `done` settles when it finishes. */
  async start(): Promise<
    { started: true; done: Promise<unknown> } | { started: false; reason: string }
  > {
    if (this.running) return { started: false, reason: 'a run is already in progress' };
    const done = this.runNow('manual').catch((err: unknown) => {
      this.log.error(`manual LBank observation run failed: ${redact(err)}`);
      return { skipped: redact(err).slice(0, 300) };
    });
    return { started: true, done };
  }
}

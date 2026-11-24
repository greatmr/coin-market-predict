import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { redact } from '../../common/security/redact.js';
import { type Clock, systemClock } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { LeaseService } from '../pipeline/lease.service.js';
import { CutoverService } from '../star-events/cutover.service.js';

import { type ObsRunReport, ObservationUpdateService } from './observation-update.service.js';

export const OBSERVATION_LEASE = 'lbank-observation';
const LEASE_TTL_MS = 15 * 60_000;
const CRON_NAME = 'lbank-observation';

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

  constructor(
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
  async runNow(
    trigger: 'schedule' | 'manual' | 'cli',
  ): Promise<ObsRunReport | { skipped: string }> {
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

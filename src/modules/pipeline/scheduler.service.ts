import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { redact } from '../../common/security/redact.js';

import { APP_CONFIG, type AppConfig, LiveConfig } from '../../config/index.js';

import { SettingsService } from '../settings/settings.service.js';
import { TelegramService } from '../telegram/telegram.service.js';

import { PipelineService } from './pipeline.service.js';

const JOBS = ['hourly-pipeline', 'telegram-delivery'] as const;

/**
 * Persistent hourly schedule (cron, UTC). Overlap is prevented by PipelineService's in-process
 * flag plus the database lease; the Telegram retry job runs independently of the pipeline.
 * `SCHEDULER_ENABLED` and `PIPELINE_CRON` are dashboard settings: a change reschedules the jobs
 * without a restart, and each scheduled run first picks up settings saved with the CLI.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(SchedulerService.name);
  private startupTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly registry: SchedulerRegistry,
    private readonly pipeline: PipelineService,
    private readonly telegram: TelegramService,
    private readonly live: LiveConfig,
    private readonly settings: SettingsService,
  ) {}

  onApplicationBootstrap() {
    this.unsubscribe = this.live.onChange((changed) => {
      if (changed.has('SCHEDULER_ENABLED') || changed.has('PIPELINE_CRON')) this.reschedule();
    });
    if (!this.cfg.SCHEDULER_ENABLED) {
      this.log.log('scheduler disabled (SCHEDULER_ENABLED=false)');
      return;
    }
    this.start();
    this.recoverSoon('application was not running during this hour');
  }

  onApplicationShutdown() {
    this.unsubscribe?.();
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.stop();
  }

  private start() {
    const hourly = CronJob.from({
      cronTime: this.cfg.PIPELINE_CRON,
      timeZone: 'UTC',
      onTick: () => void this.tick(),
      start: true,
    });
    this.registry.addCronJob('hourly-pipeline', hourly);
    const delivery = CronJob.from({
      cronTime: '*/5 * * * *',
      timeZone: 'UTC',
      onTick: () => {
        void this.telegram
          .deliverPending()
          .catch((e) => this.log.warn(`telegram retry failed: ${redact(e)}`));
        void this.pipeline
          .resumeIfInterrupted()
          .then(
            (r) =>
              r &&
              r.status !== 'skipped' &&
              this.log.log(`resumed interrupted run ${r.slot}: ${r.status}`),
          )
          .catch((e) => this.log.warn(`resume failed: ${redact(e)}`));
      },
      start: true,
    });
    this.registry.addCronJob('telegram-delivery', delivery);
    this.log.log(
      `scheduler started: pipeline "${this.cfg.PIPELINE_CRON}" UTC, next ${hourly.nextDate().toISO()}`,
    );
  }

  private stop() {
    for (const name of JOBS)
      if (this.registry.doesExist('cron', name)) this.registry.deleteCronJob(name);
  }

  /** A dashboard setting changed the schedule or turned it on or off. */
  private reschedule() {
    const wasRunning = this.registry.doesExist('cron', 'hourly-pipeline');
    this.stop();
    if (!this.cfg.SCHEDULER_ENABLED) {
      if (wasRunning) this.log.log('scheduler turned off in the settings');
      return;
    }
    this.start();
    // Turned back on: record the hours it was off as missed and catch up the current hour (policy).
    if (!wasRunning) this.recoverSoon('the scheduler was turned off during this hour');
  }

  private recoverSoon(reason: string) {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => void this.recover(reason), 5_000);
  }

  private async recover(reason: string) {
    try {
      const r = await this.pipeline.recoverOnStartup(reason);
      this.log.log(
        `recovery: ${r.missedRecorded} missed hour(s) recorded; current slot ${r.ran ? r.ran.status : 'already complete or policy=skip'}`,
      );
    } catch (err) {
      this.log.error(`recovery failed: ${redact(err)}`);
    }
  }

  private async tick() {
    try {
      // Settings saved with the CLI (or by another instance) apply from this run on.
      await this.settings.refresh();
      if (!this.cfg.SCHEDULER_ENABLED) return;
      const r = await this.pipeline.runSlot();
      this.log.log(`pipeline ${r.slot}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    } catch (err) {
      this.log.error(`pipeline tick failed: ${redact(err)}`);
    }
  }
}

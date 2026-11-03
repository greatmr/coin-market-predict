import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { PipelineService } from "./pipeline.service.js";

/**
 * Persistent hourly schedule (cron, UTC). Overlap is prevented by PipelineService's in-process
 * flag plus the database lease; the Telegram retry job runs independently of the pipeline.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(SchedulerService.name);
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly registry: SchedulerRegistry,
    private readonly pipeline: PipelineService,
    private readonly telegram: TelegramService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cfg.SCHEDULER_ENABLED) {
      this.log.log("scheduler disabled (SCHEDULER_ENABLED=false)");
      return;
    }
    const hourly = CronJob.from({
      cronTime: this.cfg.PIPELINE_CRON,
      timeZone: "UTC",
      onTick: () => void this.tick(),
      start: true,
    });
    this.registry.addCronJob("hourly-pipeline", hourly);
    const delivery = CronJob.from({
      cronTime: "*/5 * * * *",
      timeZone: "UTC",
      onTick: () => void this.telegram.deliverPending().catch((e) => this.log.warn(`telegram retry failed: ${redact(e)}`)),
      start: true,
    });
    this.registry.addCronJob("telegram-delivery", delivery);
    this.log.log(`scheduler started: pipeline "${this.cfg.PIPELINE_CRON}" UTC, next ${hourly.nextDate().toISO()}`);
    this.startupTimer = setTimeout(() => void this.recover(), 5_000);
  }

  onApplicationShutdown() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    for (const name of ["hourly-pipeline", "telegram-delivery"]) {
      if (this.registry.doesExist("cron", name)) void this.registry.getCronJob(name).stop();
    }
  }

  private async recover() {
    try {
      const r = await this.pipeline.recoverOnStartup();
      this.log.log(`startup recovery: ${r.missedRecorded} missed hour(s) recorded; current slot ${r.ran ? r.ran.status : "already complete or policy=skip"}`);
    } catch (err) {
      this.log.error(`startup recovery failed: ${redact(err)}`);
    }
  }

  private async tick() {
    try {
      const r = await this.pipeline.runSlot();
      this.log.log(`pipeline ${r.slot}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
    } catch (err) {
      this.log.error(`pipeline tick failed: ${redact(err)}`);
    }
  }
}

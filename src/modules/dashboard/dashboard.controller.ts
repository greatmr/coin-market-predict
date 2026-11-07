import { Controller, Get, Inject } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { RequirePermission } from '../auth/auth.guard.js';
import { nextCronRun } from '../pipeline/progress.js';
import { ReadModelService } from '../read-model/read-model.service.js';
import { StrategyService } from '../strategy/index.js';

/** Configuration, overview and operational history for the dashboard (read-only; history needs health:read). */
@Controller()
export class DashboardController {
  constructor(
    private readonly read: ReadModelService,
    private readonly strategy: StrategyService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get('config')
  async config() {
    const provider = await this.read.provider();
    return {
      timezone: this.cfg.DISPLAY_TIMEZONE,
      dataSource: this.cfg.DATA_SOURCE,
      isLiveData: provider?.isLive ?? this.cfg.DATA_SOURCE !== 'fixture',
      providerName: provider?.name ?? this.cfg.DATA_SOURCE,
      attribution: provider?.attribution ?? null,
      telegramMode: this.cfg.TELEGRAM_MODE,
      schedulerEnabled: this.cfg.SCHEDULER_ENABLED,
      pipelineCron: this.cfg.PIPELINE_CRON,
      nextRunAt: this.cfg.SCHEDULER_ENABLED ? nextCronRun(this.cfg.PIPELINE_CRON) : null,
      ...this.strategy.describe(),
      retention: {
        snapshotDays: this.cfg.RETENTION_SNAPSHOT_DAYS,
        detailDays: this.cfg.RETENTION_DETAIL_DAYS,
        exportDays: this.cfg.EXPORT_RETENTION_DAYS,
      },
    };
  }

  @Get('overview')
  overview() {
    return this.read.overview();
  }

  @RequirePermission('health:read')
  @Get('batches')
  batches() {
    return this.read.batches(48);
  }

  @RequirePermission('health:read')
  @Get('health')
  async health() {
    const [coverage, runs] = await Promise.all([this.read.coverage(), this.read.runs(24)]);
    return { coverage, runs };
  }

  @RequirePermission('health:read')
  @Get('runs')
  runs() {
    return this.read.runs(48);
  }

  @RequirePermission('telegram:manage')
  @Get('deliveries')
  deliveries() {
    return this.read.deliveries(20);
  }
}

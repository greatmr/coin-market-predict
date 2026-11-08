import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppStateModule } from '../app-state/app-state.module.js';
import { DailyMetricsModule } from '../daily-metrics/daily-metrics.module.js';
import { ExportsModule } from '../exports/exports.module.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { ScanModule } from '../scan/scan.module.js';
import { SourcesModule } from '../sources/sources.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { VenuesModule } from '../venues/venues.module.js';

import { JobLease } from './entities/job-lease.entity.js';
import { PipelineRun } from './entities/pipeline-run.entity.js';
import { PipelineStage } from './entities/pipeline-stage.entity.js';
import { LeaseService } from './lease.service.js';
import { PipelineService } from './pipeline.service.js';
import { RetentionService } from './retention.service.js';
import { SchedulerService } from './scheduler.service.js';

/**
 * The hourly run: discover → collect → lbank → daily → scan → venues → export → notify → retention,
 * under a database lease, with stage records, restart recovery and the cron scheduler.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PipelineRun, PipelineStage, JobLease, CrawlBatch, MarketSnapshot]),
    AppStateModule,
    IngestionModule,
    DailyMetricsModule,
    VenuesModule,
    ScanModule,
    SourcesModule,
    ExportsModule,
    TelegramModule,
  ],
  providers: [LeaseService, RetentionService, PipelineService, SchedulerService],
  exports: [PipelineService, LeaseService, RetentionService],
})
export class PipelineModule {}

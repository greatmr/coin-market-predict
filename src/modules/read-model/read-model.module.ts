import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DailyMetricRevision } from '../daily-metrics/entities/daily-metric-revision.entity.js';
import { DailyMetric } from '../daily-metrics/entities/daily-metric.entity.js';
import { CmcAssetChange } from '../ingestion/entities/cmc-asset-change.entity.js';
import { CmcAsset } from '../ingestion/entities/cmc-asset.entity.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { DiscoveryRun } from '../ingestion/entities/discovery-run.entity.js';
import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';
import { JobLease } from '../pipeline/entities/job-lease.entity.js';
import { PipelineRun } from '../pipeline/entities/pipeline-run.entity.js';
import { PipelineStage } from '../pipeline/entities/pipeline-stage.entity.js';
import { Review } from '../reviews/entities/review.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { ScanRun } from '../scan/entities/scan-run.entity.js';
import { Provider } from '../sources/entities/provider.entity.js';
import { SourceHealth } from '../sources/entities/source-health.entity.js';
import { TelegramDelivery } from '../telegram/entities/telegram-delivery.entity.js';
import { VenueCrawl } from '../venues/entities/venue-crawl.entity.js';
import { VenueDecision } from '../venues/entities/venue-decision.entity.js';
import { VenueMappingTask } from '../venues/entities/venue-mapping-task.entity.js';

import { ReadModelService } from './read-model.service.js';

/** Read-only projections (sheets, calculation traces, batches, exports, runs) for the dashboard, MCP, Telegram and the CLI. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Provider,
      SourceHealth,
      DiscoveryRun,
      CrawlBatch,
      MarketSnapshot,
      CmcAsset,
      CmcAssetChange,
      DailyMetric,
      DailyMetricRevision,
      VenueCrawl,
      VenueDecision,
      VenueMappingTask,
      ScanRun,
      ScanResult,
      Review,
      PipelineRun,
      PipelineStage,
      JobLease,
      TelegramDelivery,
    ]),
  ],
  providers: [ReadModelService],
  exports: [ReadModelService],
})
export class ReadModelModule {}

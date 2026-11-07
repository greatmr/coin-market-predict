import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DailyMetric } from '../daily-metrics/entities/daily-metric.entity.js';
import { CmcAsset } from '../ingestion/entities/cmc-asset.entity.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';
import { StrategyModule } from '../strategy/index.js';
import { VenueCrawl } from '../venues/entities/venue-crawl.entity.js';
import { VenueDecision } from '../venues/entities/venue-decision.entity.js';
import { VenueMappingTask } from '../venues/entities/venue-mapping-task.entity.js';
import { VenuePairEvent } from '../venues/entities/venue-pair-event.entity.js';

import { ScanResult } from './entities/scan-result.entity.js';
import { ScanRun } from './entities/scan-run.entity.js';
import { ScanService } from './scan.service.js';

/** Tier 1 scan of a stored crawl batch: applies the strategy module's rules and persists the results. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ScanRun,
      ScanResult,
      CrawlBatch,
      MarketSnapshot,
      CmcAsset,
      DailyMetric,
      VenueCrawl,
      VenueDecision,
      VenuePairEvent,
      VenueMappingTask,
    ]),
    StrategyModule,
  ],
  providers: [ScanService],
  exports: [ScanService],
})
export class ScanModule {}

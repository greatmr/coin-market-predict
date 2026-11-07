import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DailyMetric } from '../daily-metrics/entities/daily-metric.entity.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { VenueDecision } from '../venues/entities/venue-decision.entity.js';
import { VenueMappingTask } from '../venues/entities/venue-mapping-task.entity.js';

import { Review } from './entities/review.entity.js';
import { ReviewService } from './review.service.js';

/** Append-only human records: review revisions (validated by the strategy's review rules) and LBank venue decisions. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Review,
      ScanResult,
      CrawlBatch,
      DailyMetric,
      VenueDecision,
      VenueMappingTask,
    ]),
  ],
  providers: [ReviewService],
  exports: [ReviewService],
})
export class ReviewsModule {}

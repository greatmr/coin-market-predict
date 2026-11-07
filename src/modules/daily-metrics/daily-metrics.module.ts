import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SourcesModule } from '../sources/sources.module.js';

import { DailyMetricsService } from './daily-metrics.service.js';
import { DailyFetchState } from './entities/daily-fetch-state.entity.js';
import { DailyMetricRevision } from './entities/daily-metric-revision.entity.js';
import { DailyMetric } from './entities/daily-metric.entity.js';

/** Completed UTC daily rows (Tier 1 input): refresh from the source, manual CSV import, every revision kept. */
@Module({
  imports: [
    TypeOrmModule.forFeature([DailyMetric, DailyMetricRevision, DailyFetchState]),
    SourcesModule,
  ],
  providers: [DailyMetricsService],
  exports: [DailyMetricsService],
})
export class DailyMetricsModule {}

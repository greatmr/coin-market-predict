import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DailyMetricsModule } from '../daily-metrics/daily-metrics.module.js';
import { StrategyModule } from '../strategy/index.js';

import { ForwardEvent } from './entities/forward-event.entity.js';
import { ForwardHigh } from './entities/forward-high.entity.js';
import { ForwardOutcome } from './entities/forward-outcome.entity.js';
import { ForwardTestWatchlist } from './entities/forward-test-watchlist.entity.js';
import { ForwardTriggerRejection } from './entities/forward-trigger-rejection.entity.js';
import { ForwardTriggerRun } from './entities/forward-trigger-run.entity.js';
import { ForwardUpdateRun } from './entities/forward-update-run.entity.js';
import { ForwardCaptureService } from './forward-capture.service.js';
import { ForwardExportService } from './forward-export.service.js';
import { ForwardReadService } from './forward-read.service.js';
import { ForwardTestService } from './forward-test.service.js';
import { ForwardUpdateService } from './forward-update.service.js';

/**
 * Star Event Forward Test (docs/forward-test.md, ADR-0004): trigger on the published Review Queue,
 * the daily High update, versioned outcomes, the star-group report and its export. It reads Tier 1
 * results and the crawler's daily rows and never changes a Tier 1 rule or result.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ForwardTestWatchlist,
      ForwardTriggerRun,
      ForwardTriggerRejection,
      ForwardEvent,
      ForwardUpdateRun,
      ForwardHigh,
      ForwardOutcome,
    ]),
    DailyMetricsModule,
    StrategyModule,
  ],
  providers: [
    ForwardCaptureService,
    ForwardUpdateService,
    ForwardReadService,
    ForwardExportService,
    ForwardTestService,
  ],
  exports: [
    ForwardTestService,
    ForwardReadService,
    ForwardExportService,
    ForwardCaptureService,
    ForwardUpdateService,
  ],
})
export class ForwardTestModule {}

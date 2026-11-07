import { Module } from '@nestjs/common';

import { PipelineModule } from '../pipeline/pipeline.module.js';
import { ReadModelModule } from '../read-model/read-model.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { StrategyModule } from '../strategy/index.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { VenuesModule } from '../venues/venues.module.js';

import { AssetsController } from './assets.controller.js';
import { DashboardController } from './dashboard.controller.js';
import { ExportsController } from './exports.controller.js';
import { LbankController } from './lbank.controller.js';
import { ReviewsController } from './reviews.controller.js';
import { ScanController } from './scan.controller.js';
import { TelegramAccessController } from './telegram-access.controller.js';

/**
 * The JSON API behind the dashboard (`/api/*`). Reads go through the read model; the few writes need
 * JSON, the same origin, and loopback or Basic auth (`common/security/write-guard.ts`). The only
 * module that imports the domain modules for HTTP, so they stay free of transport code.
 */
@Module({
  imports: [
    ReadModelModule,
    StrategyModule,
    PipelineModule,
    ReviewsModule,
    VenuesModule,
    TelegramModule,
  ],
  controllers: [
    DashboardController,
    ScanController,
    AssetsController,
    ExportsController,
    ReviewsController,
    LbankController,
    TelegramAccessController,
  ],
})
export class DashboardModule {}

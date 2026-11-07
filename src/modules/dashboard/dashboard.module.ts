import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from '../auth/auth.guard.js';
import { AuthModule, OwnerBootstrap } from '../auth/auth.module.js';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { ReadModelModule } from '../read-model/read-model.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { StrategyModule } from '../strategy/index.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { VenuesModule } from '../venues/venues.module.js';

import { AssetsController } from './assets.controller.js';
import { AuthController } from './auth.controller.js';
import { DashboardController } from './dashboard.controller.js';
import { ExportsController } from './exports.controller.js';
import { LbankController } from './lbank.controller.js';
import { ReviewsController } from './reviews.controller.js';
import { ScanController } from './scan.controller.js';
import { TelegramAccessController } from './telegram-access.controller.js';
import { UsersController } from './users.controller.js';

/**
 * The JSON API behind the dashboard (`/api/*`). Every route needs a signed-in user whose role has
 * the route's permission (`AuthGuard`, registered globally here); writes must also be same-origin
 * JSON. Starting the server creates the bootstrap owner when none is active. The only module that
 * imports the domain modules for HTTP, so they stay free of transport code.
 */
@Module({
  imports: [
    ReadModelModule,
    StrategyModule,
    PipelineModule,
    ReviewsModule,
    VenuesModule,
    TelegramModule,
    AuthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }, OwnerBootstrap],
  controllers: [
    AuthController,
    UsersController,
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

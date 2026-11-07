import { type DynamicModule, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { type AppConfig, AppConfigModule } from './config/index.js';

import { DatabaseModule } from './database/database.module.js';

import { AuthModule } from './modules/auth/auth.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { McpModule } from './modules/mcp/mcp.module.js';
import { PipelineModule } from './modules/pipeline/pipeline.module.js';
import { ReadModelModule } from './modules/read-model/read-model.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { StrategyModule } from './modules/strategy/index.js';
import { TelegramBotModule } from './modules/telegram/telegram-bot.module.js';

import { HealthModule } from './health/health.module.js';

/**
 * Root module. The configuration is validated before Nest boots and passed in, so every entry point
 * (server, CLI, MCP stdio, tests) composes the same domain graph; `http: false` leaves out only the
 * transport layer: the dashboard API, the liveness probe and the Telegram bot poller (only the web
 * server answers bot commands).
 */
@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig, opts: { http: boolean } = { http: true }): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(cfg),
        DatabaseModule.forRoot(),
        ScheduleModule.forRoot(),
        StrategyModule,
        PipelineModule,
        ReviewsModule,
        ReadModelModule,
        McpModule,
        AuthModule,
        ...(opts.http ? [HealthModule, DashboardModule, TelegramBotModule] : []),
      ],
    };
  }
}

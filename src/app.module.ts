import { type DynamicModule, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import type { AppConfig } from "./config/config.js";
import { CoreModule } from "./core.module.js";
import { DashboardModule } from "./dashboard/dashboard.module.js";
import { McpModule } from "./mcp/mcp.module.js";
import { PipelineModule } from "./pipeline/pipeline.module.js";
import { TelegramBotModule } from "./telegram/telegram-bot.module.js";
import { VmcModule } from "./vmc/vmc.module.js";

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig, opts: { http: boolean } = { http: true }): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(cfg), ScheduleModule.forRoot(), PipelineModule, McpModule, VmcModule, ...(opts.http ? [DashboardModule, TelegramBotModule] : [])],
    };
  }
}

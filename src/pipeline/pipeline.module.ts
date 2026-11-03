import { Module } from "@nestjs/common";
import { AgentsModule } from "../agents/agents.module.js";
import { BacktestService } from "../evaluation/backtest.service.js";
import { EvaluationService } from "../evaluation/evaluation.service.js";
import { FeaturesService } from "../features/features.service.js";
import { IngestionService } from "../ingestion/ingestion.service.js";
import { ScreeningService } from "../screening/screening.service.js";
import { SourcesModule } from "../sources/sources.module.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { VmcModule } from "../vmc/vmc.module.js";
import { LeaseService } from "./lease.service.js";
import { PipelineService } from "./pipeline.service.js";
import { RetentionService } from "./retention.service.js";
import { SchedulerService } from "./scheduler.service.js";

@Module({
  imports: [SourcesModule, AgentsModule, TelegramModule, VmcModule],
  providers: [IngestionService, FeaturesService, ScreeningService, EvaluationService, BacktestService, LeaseService, RetentionService, PipelineService, SchedulerService],
  exports: [IngestionService, FeaturesService, ScreeningService, EvaluationService, BacktestService, RetentionService, PipelineService, TelegramModule],
})
export class PipelineModule {}

import { Module } from "@nestjs/common";
import { IngestionService } from "../ingestion/ingestion.service.js";
import { SourcesModule } from "../sources/sources.module.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { Tier1Module } from "../tier1/tier1.module.js";
import { LeaseService } from "./lease.service.js";
import { PipelineService } from "./pipeline.service.js";
import { RetentionService } from "./retention.service.js";
import { SchedulerService } from "./scheduler.service.js";

@Module({
  imports: [SourcesModule, Tier1Module, TelegramModule],
  providers: [IngestionService, LeaseService, RetentionService, PipelineService, SchedulerService],
  exports: [IngestionService, RetentionService, PipelineService, LeaseService, TelegramModule, Tier1Module],
})
export class PipelineModule {}

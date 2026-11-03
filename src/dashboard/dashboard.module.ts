import { Module } from "@nestjs/common";
import { AgentsModule } from "../agents/agents.module.js";
import { PipelineModule } from "../pipeline/pipeline.module.js";
import { DashboardController } from "./dashboard.controller.js";

@Module({ imports: [PipelineModule, AgentsModule], controllers: [DashboardController] })
export class DashboardModule {}

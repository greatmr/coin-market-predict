import { Module } from "@nestjs/common";
import { PipelineModule } from "../pipeline/pipeline.module.js";
import { DashboardController } from "./dashboard.controller.js";

@Module({ imports: [PipelineModule], controllers: [DashboardController] })
export class DashboardModule {}

import { Module } from "@nestjs/common";
import { PipelineModule } from "../pipeline/pipeline.module.js";
import { TelegramBotService } from "./telegram-bot.service.js";

/** Inbound bot commands. Imported only by the web server (see AppModule) to avoid poll conflicts. */
@Module({ imports: [PipelineModule], providers: [TelegramBotService], exports: [TelegramBotService] })
export class TelegramBotModule {}

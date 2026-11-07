import { Module } from '@nestjs/common';

import { AppStateModule } from '../app-state/app-state.module.js';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { ReadModelModule } from '../read-model/read-model.module.js';

import { TelegramBotService } from './telegram-bot.service.js';
import { TelegramModule } from './telegram.module.js';

/** Inbound bot commands. Imported only by the web server (see AppModule) to avoid poll conflicts. */
@Module({
  imports: [PipelineModule, TelegramModule, ReadModelModule, AppStateModule],
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramBotModule {}

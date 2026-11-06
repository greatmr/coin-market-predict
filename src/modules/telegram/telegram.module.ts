import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppStateModule } from '../app-state/app-state.module.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { PipelineRun } from '../pipeline/entities/pipeline-run.entity.js';
import { ReadModelModule } from '../read-model/read-model.module.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { ScanRun } from '../scan/entities/scan-run.entity.js';
import { Provider } from '../sources/entities/provider.entity.js';

import { TelegramAccessService } from './access.service.js';
import { TelegramAdminService } from './admin.service.js';
import { TelegramDelivery } from './entities/telegram-delivery.entity.js';
import { ReportService } from './report.service.js';
import { TELEGRAM_FETCH, TelegramService } from './telegram.service.js';

/** Telegram summary of each scanned batch (built from the database), delivery with retries, and access control. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TelegramDelivery,
      PipelineRun,
      ScanRun,
      ScanResult,
      CrawlBatch,
      Provider,
    ]),
    AppStateModule,
    ReadModelModule,
  ],
  providers: [
    { provide: TELEGRAM_FETCH, useValue: (...args: Parameters<typeof fetch>) => fetch(...args) },
    TelegramService,
    ReportService,
    TelegramAccessService,
    TelegramAdminService,
  ],
  exports: [
    TelegramService,
    ReportService,
    TelegramAccessService,
    TelegramAdminService,
    TELEGRAM_FETCH,
  ],
})
export class TelegramModule {}

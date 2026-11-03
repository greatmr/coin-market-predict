import { Module } from "@nestjs/common";
import { ReportService } from "./report.service.js";
import { TELEGRAM_FETCH, TelegramService } from "./telegram.service.js";

@Module({
  providers: [{ provide: TELEGRAM_FETCH, useValue: (...args: Parameters<typeof fetch>) => fetch(...args) }, TelegramService, ReportService],
  exports: [TelegramService, ReportService, TELEGRAM_FETCH],
})
export class TelegramModule {}

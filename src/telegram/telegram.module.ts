import { Module } from "@nestjs/common";
import { TelegramAccessService } from "./access.service.js";
import { TelegramAdminService } from "./admin.service.js";
import { ReportService } from "./report.service.js";
import { TELEGRAM_FETCH, TelegramService } from "./telegram.service.js";

@Module({
  providers: [{ provide: TELEGRAM_FETCH, useValue: (...args: Parameters<typeof fetch>) => fetch(...args) }, TelegramService, ReportService, TelegramAccessService, TelegramAdminService],
  exports: [TelegramService, ReportService, TelegramAccessService, TelegramAdminService, TELEGRAM_FETCH],
})
export class TelegramModule {}

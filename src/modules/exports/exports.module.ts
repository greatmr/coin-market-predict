import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { Review } from '../reviews/entities/review.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { ScanRun } from '../scan/entities/scan-run.entity.js';

import { ExportService } from './export.service.js';

/** Per-batch CSV + XLSX exports with a SHA-256 manifest (PDF p.17, p.18); old files are pruned, the database keeps every result. */
@Module({
  imports: [TypeOrmModule.forFeature([ScanRun, ScanResult, CrawlBatch, Review])],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportsModule {}

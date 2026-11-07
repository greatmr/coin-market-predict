import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { RequirePermission } from '../auth/auth.guard.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { ReadModelService } from '../read-model/read-model.service.js';

import { type OptionalBatchDto, OptionalBatchSchema } from './dto/common.dto.js';
import { type ScanQueryDto, ScanQuerySchema } from './dto/scan.dto.js';

/** Tier 1 result sheets and reprocessing of a stored batch. */
@Controller('scan')
export class ScanController {
  constructor(
    private readonly read: ReadModelService,
    private readonly pipeline: PipelineService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get()
  sheet(@Query(new ZodValidationPipe(ScanQuerySchema)) q: ScanQueryDto) {
    return this.read.scanSheet({
      sheet: q.sheet,
      batchId: q.batchId,
      search: q.search || undefined,
      limit: q.limit,
      offset: q.offset,
    });
  }

  /** Recompute a stored batch (default: the latest) and re-export it; never crawls. */
  @RequirePermission('scan:operate')
  @Post('rescan')
  async rescan(@Body(new ZodValidationPipe(OptionalBatchSchema)) body: OptionalBatchDto) {
    const r = await this.pipeline.reprocess(body.batchId);
    if (r.skipped) return { ok: false, reason: r.skipped };
    return {
      ok: true,
      batchId: r.batchId,
      queueStatus: r.scan?.queueStatus,
      counts: r.scan?.counts,
      export: r.export?.status,
    };
  }
}

import { Controller, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { RequirePermission } from '../auth/auth.guard.js';
import { ForwardExportService } from '../forward-test/forward-export.service.js';
import { ForwardReadService } from '../forward-test/forward-read.service.js';
import { PipelineService } from '../pipeline/pipeline.service.js';

import { UuidSchema } from './dto/common.dto.js';
import {
  type ForwardEventsQueryDto,
  ForwardEventsQuerySchema,
  ForwardExportFileSchema,
  type ForwardRejectionsQueryDto,
  ForwardRejectionsQuerySchema,
} from './dto/forward.dto.js';

/**
 * Star Event Forward Test (docs/forward-test.md): star-group report, active and finalized events,
 * one event's Highs and outcome versions, rejected triggers. Market-derived data (`data:read`);
 * bulk downloads need `exports:read`; running the daily update needs `scan:operate`.
 */
@Controller('forward')
export class ForwardController {
  constructor(
    private readonly read: ForwardReadService,
    private readonly exporter: ForwardExportService,
    private readonly pipeline: PipelineService,
  ) {}

  @Get()
  summary() {
    return this.read.summary();
  }

  @Get('events')
  events(@Query(new ZodValidationPipe(ForwardEventsQuerySchema)) q: ForwardEventsQueryDto) {
    return this.read.events({
      view: q.view,
      stars: q.stars,
      search: q.search || undefined,
      limit: q.limit,
      offset: q.offset,
    });
  }

  @Get('events/:id')
  async event(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) {
    const e = await this.read.event(id);
    if (!e)
      throw new NotFoundException({
        message: 'no forward-test event with this id',
        code: ErrorCodes.FORWARD_EVENT_NOT_FOUND,
      });
    return e;
  }

  @Get('rejections')
  rejections(
    @Query(new ZodValidationPipe(ForwardRejectionsQuerySchema)) q: ForwardRejectionsQueryDto,
  ) {
    return this.read.rejections(q.limit);
  }

  /** A sheet as CSV or the whole workbook, generated from the database now (not enveloped). */
  @RequirePermission('exports:read')
  @Get('export/:file')
  async download(
    @Param('file', new ZodValidationPipe(ForwardExportFileSchema)) file: string,
    @Res() res: Response,
  ) {
    const out = await this.exporter.render(file);
    if (!out)
      throw new NotFoundException({
        message: 'unknown forward-test export file',
        code: ErrorCodes.EXPORT_FILE_NOT_FOUND,
      });
    const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
    res.setHeader('content-type', out.type);
    res.setHeader('content-disposition', `attachment; filename="forward-test_${stamp}Z_${file}"`);
    res.send(out.body);
  }

  /** The daily High update now, under the pipeline lease (it never creates an event). */
  @RequirePermission('scan:operate')
  @Post('update')
  async update() {
    const r = await this.pipeline.runForwardUpdate();
    if ('skipped' in r) return { ok: false, reason: r.skipped };
    return {
      ok: r.update && !('skipped' in r.update) && r.update.status !== 'failed',
      update: r.update,
      export: r.export,
    };
  }
}

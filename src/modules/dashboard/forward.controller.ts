import { Controller, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { RequirePermission } from '../auth/auth.guard.js';
import { ForwardExportService } from '../forward-test/forward-export.service.js';
import { ForwardReadService } from '../forward-test/forward-read.service.js';
import { ForwardRetirementService } from '../forward-test/forward-retirement.service.js';
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
    private readonly retirement: ForwardRetirementService,
  ) {}

  /**
   * The legacy tracker's state after the cutover (docs/forward-test.md § 15): active, closing (the
   * cutover passed, pre-cutover events still finishing) or retired, with each terminal outcome's
   * count and reasons. The dashboard hides the page from navigation once retired.
   */
  @Get('legacy')
  legacy() {
    return this.retirement.evaluate(this.read.providerId, new Date(), { write: false });
  }

  /** Administrative export of every legacy event's terminal closure (CSV). */
  @RequirePermission('exports:read')
  @Get('legacy/closures.csv')
  async legacyClosures(@Res() res: Response) {
    const rows = await this.retirement.closuresFor(this.read.providerId);
    const lines = [
      'event_id,closure,status_at_closure,outcome_version,peak_kind,peak_return_pct,reasons,closed_at_utc,rules_version',
      ...rows.map((r) =>
        [
          r.eventId,
          r.closure,
          r.statusAtClosure,
          r.outcomeVersion,
          r.peakKind ?? '',
          r.peakReturnPct?.toFixed() ?? '',
          `"${r.reasons.join(' ').replace(/"/g, '""')}"`,
          r.closedAt.toISOString(),
          r.rulesVersion,
        ].join(','),
      ),
    ];
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="forward-test_legacy-closures.csv"');
    res.send(`${lines.join('\n')}\n`);
  }

  @Get()
  summary() {
    return this.read.summary();
  }

  @Get('events')
  events(@Query(new ZodValidationPipe(ForwardEventsQuerySchema)) q: ForwardEventsQueryDto) {
    return this.read.events({
      view: q.view,
      status: q.status,
      result: q.result,
      market: q.market,
      bithumb: q.bithumb,
      sort: q.sort,
      dir: q.dir,
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

  /** The same coin's other events whose windows overlap this one's (correlated observations). */
  @Get('events/:id/overlaps')
  async overlaps(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) {
    const o = await this.read.overlaps(id);
    if (!o)
      throw new NotFoundException({
        message: 'no forward-test event with this id',
        code: ErrorCodes.FORWARD_EVENT_NOT_FOUND,
      });
    return o;
  }

  /** One daily High update: progress while it runs, then its per-event check counts. */
  @Get('update-runs/:id')
  async updateRun(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) {
    const r = await this.read.updateRun(id);
    if (!r)
      throw new NotFoundException({
        message: 'no forward-test update run with this id',
        code: ErrorCodes.FORWARD_UPDATE_RUN_NOT_FOUND,
      });
    return r;
  }

  @Get('rejections')
  rejections(
    @Query(new ZodValidationPipe(ForwardRejectionsQuerySchema)) q: ForwardRejectionsQueryDto,
  ) {
    return this.read.rejections(q.limit);
  }

  /** A sheet as CSV, generated from the database now (not enveloped). */
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

  /**
   * Start the daily High update now, in the background under the pipeline lease (it never creates
   * an event). Returns the run id to follow at `GET /api/forward/update-runs/:id`.
   */
  @RequirePermission('scan:operate')
  @Post('update')
  async update() {
    const r = await this.pipeline.startForwardUpdate();
    if (!r.started) return { ok: false, reason: r.reason };
    return { ok: true, updateRunId: r.updateRunId };
  }
}

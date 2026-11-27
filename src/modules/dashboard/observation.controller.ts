import { Controller, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { RequirePermission } from '../auth/auth.guard.js';
import { ObservationReadService } from '../lbank-observation/observation-read.service.js';
import { ObservationService } from '../lbank-observation/observation.service.js';

import { UuidSchema } from './dto/common.dto.js';
import {
  type ObservationExportQueryDto,
  ObservationExportQuerySchema,
  type ObservationFilterDto,
  ObservationFilterSchema,
  type ObservationListQueryDto,
  ObservationListQuerySchema,
} from './dto/observation.dto.js';

/**
 * LBank Spot Price Observation (docs/lbank-spot-observation.md): observations of CMC star events
 * detected at or after the cutover, measured on LBank Spot 1-minute candles. Market-derived data
 * (`data:read`); the CSV export needs `exports:read`; starting a run needs `scan:operate`.
 */
@Controller('observations')
export class ObservationController {
  constructor(
    private readonly read: ObservationReadService,
    private readonly job: ObservationService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(ObservationListQuerySchema)) q: ObservationListQueryDto) {
    return this.read.list({ ...q, search: q.search || undefined });
  }

  /** Final-only statistics (with denominators) for the same filters, the cutover and the last run. */
  @Get('summary')
  summary(@Query(new ZodValidationPipe(ObservationFilterSchema)) q: ObservationFilterDto) {
    return this.read.summary({ ...q, search: q.search || undefined });
  }

  /** Change token: the page reloads when the latest run or stored change differs. */
  @Get('version')
  version() {
    return this.read.version();
  }

  /** The job's recent runs. */
  @Get('runs')
  runs() {
    return this.read.runs();
  }

  /** Routing check: every post-cutover queue row accounted for, nothing in both trackers. */
  @RequirePermission('health:read')
  @Get('routing-check')
  routingCheck() {
    return this.read.routingCheck();
  }

  @RequirePermission('exports:read')
  @Get('export.csv')
  async export(
    @Query(new ZodValidationPipe(ObservationExportQuerySchema)) q: ObservationExportQueryDto,
    @Res() res: Response,
  ) {
    const body = await this.read.csv({ ...q, search: q.search || undefined });
    const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="lbank-spot-observation_${stamp}Z.csv"`,
    );
    res.send(body);
  }

  @Get(':id')
  async detail(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) {
    const d = await this.read.detail(id);
    if (!d)
      throw new NotFoundException({
        message: 'no observation with this id',
        code: ErrorCodes.OBSERVATION_NOT_FOUND,
      });
    return d;
  }

  /** The same coin's other observations whose windows overlap this one (correlated). */
  @Get(':id/overlaps')
  async overlaps(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) {
    const o = await this.read.overlaps(id);
    if (!o)
      throw new NotFoundException({
        message: 'no observation with this id',
        code: ErrorCodes.OBSERVATION_NOT_FOUND,
      });
    return o;
  }

  /** Run the observation job now, in the background under its own lease. */
  @RequirePermission('scan:operate')
  @Post('update')
  async update() {
    const r = await this.job.start();
    return r.started ? { ok: true } : { ok: false, reason: r.reason };
  }
}

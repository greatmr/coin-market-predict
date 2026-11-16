import { Controller, Param, Post } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { type AuthContext, CurrentAuth, RequirePermission } from '../auth/auth.guard.js';
import { PipelineService } from '../pipeline/pipeline.service.js';

import { UuidSchema } from './dto/common.dto.js';

/** Manual control of the hourly crawl. */
@Controller('pipeline')
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  /**
   * Reset an open circuit breaker and crawl the current slot again. Answers as soon as the run has
   * started (or why it could not); the dashboard follows progress through the overview.
   */
  @RequirePermission('scan:operate')
  @Post('retry')
  async retry() {
    const r = await this.pipeline.retryCrawl();
    if (!r.started) return { ok: false, slot: r.slot, reason: r.reason };
    void r.done; // runs in the background; the outcome is stored on the pipeline run
    return { ok: true, slot: r.slot, circuitReset: r.circuitReset };
  }

  /**
   * Owner's "Recover" on a failed or missed run (PipelineService.recoverRun): re-crawl the current
   * hour, reprocess a stored batch, or catch up what can still be fetched. Runs in the background;
   * the outcome is stored in the run's `metrics.recovery`.
   */
  @RequirePermission('pipeline:recover')
  @Post('runs/:id/recover')
  async recover(
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
    @CurrentAuth() a: AuthContext,
  ) {
    const r = await this.pipeline.recoverRun(id, a.user.username);
    if (!r.started) return { ok: false, slot: r.slot, reason: r.reason };
    void r.done;
    return { ok: true, slot: r.slot, action: r.action, batchId: r.batchId };
  }
}

import { Controller, Post } from '@nestjs/common';

import { RequirePermission } from '../auth/auth.guard.js';
import { PipelineService } from '../pipeline/pipeline.service.js';

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
}

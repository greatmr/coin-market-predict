import { Controller, Get, Inject, Post } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { RequirePermission } from '../auth/auth.guard.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { VenuesService } from '../venues/venues.service.js';

/** The stored LBank Spot markets list (operator decisions D1, D2). */
@Controller('lbank')
export class LbankController {
  constructor(
    private readonly venues: VenuesService,
    private readonly pipeline: PipelineService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Fetch time, age, next automatic refresh and the last attempt of the stored list. */
  @Get()
  async status() {
    return {
      list: await this.venues.lbankListStatus(this.cfg.DATA_SOURCE),
      refreshDays: this.cfg.LBANK_PAIRS_REFRESH_DAYS,
      maxAgeDays: this.cfg.LBANK_PAIRS_MAX_AGE_DAYS,
      requireManualVerification: this.cfg.LBANK_REQUIRE_MANUAL_VERIFICATION,
    };
  }

  /** Fetch the list now, then recompute and re-export the latest batch. */
  @RequirePermission('scan:operate')
  @Post('refresh')
  async refresh() {
    const r = await this.pipeline.refreshLbankPairs();
    if ('skipped' in r) return { ok: false, reason: r.skipped };
    return {
      ok: r.lbank.usable,
      status: r.lbank.status,
      pairs: r.lbank.pairs,
      expected: r.lbank.expected,
      notes: r.lbank.notes,
      listFetchedAt: r.lbank.listFetchedAt,
      nextRefreshAt: r.lbank.nextRefreshAt,
      batchId: r.batchId,
      queueStatus: r.scan?.queueStatus ?? null,
      counts: r.scan?.counts ?? null,
    };
  }
}

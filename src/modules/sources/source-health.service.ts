import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { CMC_WEB_PROVIDER } from './coinmarketcap-web/client.js';
import { SourceHealth } from './entities/source-health.entity.js';
import {
  type SourceHealthState,
  type SourceHealthStore,
  initialHealth,
} from './http/source-health.js';

const HOUR_MS = 3_600_000;
/** Requests every hourly batch needs for the rest of the month: listing (1) + LBank pair pages (2). */
export const PER_RUN_RESERVED_REQUESTS = 3;

/**
 * Circuit-breaker and request-budget state persisted in PostgreSQL so it survives restarts
 * (the `SourceHealthStore` of the polite HTTP clients), plus the budget arithmetic Tier 1 crawls use.
 */
@Injectable()
export class SourceHealthService implements SourceHealthStore {
  constructor(
    @InjectRepository(SourceHealth) private readonly repo: Repository<SourceHealth>,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  find(providerId: string): Promise<SourceHealth | null> {
    return this.repo.findOneBy({ providerId });
  }

  async load(providerId: string): Promise<SourceHealthState> {
    const row = await this.find(providerId);
    if (!row) return initialHealth();
    return {
      state: row.state,
      consecutiveFailures: row.consecutiveFailures,
      consecutiveDenials: row.consecutiveDenials,
      openedAt: row.openedAt,
      retryAfterUntil: row.retryAfterUntil,
      suspendedReason: row.suspendedReason,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastStatusCode: row.lastStatusCode,
      budgetPeriodStart: row.budgetPeriodStart,
      budgetUsed: row.budgetUsed,
    };
  }

  /** The provider row must exist (callers ensure it: see `SourcesModule`). */
  async save(providerId: string, s: SourceHealthState): Promise<void> {
    await this.repo.upsert({ providerId, ...s }, ['providerId']);
  }

  /** Close a suspended/open circuit after the operator resolved the cause (`source:reset`). */
  async reset(providerId: string): Promise<number> {
    const r = await this.repo.update(
      { providerId },
      {
        state: 'closed',
        consecutiveFailures: 0,
        consecutiveDenials: 0,
        suspendedReason: null,
        openedAt: null,
        retryAfterUntil: null,
      },
    );
    return r.affected ?? 0;
  }

  /**
   * Website requests that Tier 1 crawls (daily history, venue rows) may still spend this month
   * without endangering the hourly listing and LBank crawl: the monthly budget minus what was used
   * minus a reserve for every remaining hour. Infinite for sources without a request budget.
   */
  async spendableRequests(providerId: string, now = new Date()): Promise<number> {
    if (providerId !== CMC_WEB_PROVIDER.id) return Number.POSITIVE_INFINITY;
    const h = await this.find(providerId);
    const period = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const used = h?.budgetPeriodStart?.getTime() === period ? h.budgetUsed : 0;
    const hoursLeft = Math.ceil(
      (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / HOUR_MS,
    );
    return this.cfg.CMC_WEB_MONTHLY_REQUEST_BUDGET - used - hoursLeft * PER_RUN_RESERVED_REQUESTS;
  }
}

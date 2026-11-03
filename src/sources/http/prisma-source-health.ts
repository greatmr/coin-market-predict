import type { PrismaService } from "../../prisma/prisma.service.js";
import { initialHealth, type SourceHealthState, type SourceHealthStore } from "./source-health.js";

/** Circuit-breaker / budget state persisted in PostgreSQL so it survives restarts. */
export class PrismaSourceHealthStore implements SourceHealthStore {
  constructor(private readonly prisma: PrismaService) {}

  async load(providerId: string): Promise<SourceHealthState> {
    const row = await this.prisma.sourceHealth.findUnique({ where: { providerId } });
    if (!row) return initialHealth();
    return {
      state: row.state as SourceHealthState["state"],
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

  async save(providerId: string, s: SourceHealthState): Promise<void> {
    await this.prisma.sourceHealth.upsert({ where: { providerId }, create: { providerId, ...s }, update: s });
  }
}


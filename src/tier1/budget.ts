import type { AppConfig } from "../config/config.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import { CMC_WEB_PROVIDER } from "../sources/coinmarketcap-web/client.js";

const HOUR_MS = 3_600_000;
/** Requests every hourly batch needs for the rest of the month: listing (1) + LBank pair pages (2). */
export const PER_RUN_RESERVED_REQUESTS = 3;

/**
 * Website requests that Tier 1 crawls (daily history, venue rows) may still spend this month
 * without endangering the hourly listing and LBank crawl: the monthly budget minus what was used
 * minus a reserve for every remaining hour. Infinite for sources without a request budget.
 */
export async function spendableRequests(prisma: PrismaService, cfg: AppConfig, providerId: string, now = new Date()): Promise<number> {
  if (providerId !== CMC_WEB_PROVIDER.id) return Number.POSITIVE_INFINITY;
  const h = await prisma.sourceHealth.findUnique({ where: { providerId } });
  const period = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const used = h?.budgetPeriodStart?.getTime() === period ? h.budgetUsed : 0;
  const hoursLeft = Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / HOUR_MS);
  return cfg.CMC_WEB_MONTHLY_REQUEST_BUDGET - used - hoursLeft * PER_RUN_RESERVED_REQUESTS;
}

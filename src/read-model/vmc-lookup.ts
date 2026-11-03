import type { PrismaService } from "../prisma/prisma.service.js";
import { toNum } from "../prisma/prisma.service.js";

/** Providers whose asset ids are CoinMarketCap numeric ids (usable by the VMC baseline module). */
export const CMC_PROVIDERS: ReadonlySet<string> = new Set(["coinmarketcap", "coinmarketcap_web"]);

export interface BaselineSummary {
  meanRatio: number | null;
  status: string;
  validDays: number;
  windowStart: string;
  windowEnd: string;
}

/** CoinMarketCap numeric id per canonical asset, for CMC-based providers only. */
export async function cmcIdsFor(prisma: PrismaService, providerId: string, assetIds: string[]): Promise<Map<string, number>> {
  if (!CMC_PROVIDERS.has(providerId) || !assetIds.length) return new Map();
  const rows = await prisma.assetIdentity.findMany({ where: { providerId, assetId: { in: assetIds } }, select: { assetId: true, providerAssetId: true } });
  return new Map(rows.filter((r) => /^\d+$/.test(r.providerAssetId)).map((r) => [r.assetId, Number(r.providerAssetId)]));
}

/** Latest six-month VMC baseline per CMC id (computed by the VMC module from daily history). */
export async function latestBaselines(prisma: PrismaService, cmcIds: number[]): Promise<Map<number, BaselineSummary>> {
  if (!cmcIds.length) return new Map();
  const rows = await prisma.vmcBaseline.findMany({ where: { cmcId: { in: cmcIds } }, orderBy: [{ cmcId: "asc" }, { version: "desc" }] });
  const out = new Map<number, BaselineSummary>();
  for (const b of rows) {
    if (out.has(b.cmcId)) continue;
    out.set(b.cmcId, { meanRatio: toNum(b.meanRatio), status: b.status, validDays: b.validDays, windowStart: b.windowStart.toISOString().slice(0, 10), windowEnd: b.windowEnd.toISOString().slice(0, 10) });
  }
  return out;
}

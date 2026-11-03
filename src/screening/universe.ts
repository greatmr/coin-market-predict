/**
 * Which coins the strategy can evaluate at a slot. One definition is shared by feature
 * computation, screening, history backfill, retention and the dashboard so they never disagree.
 * Pure functions: no database access.
 */

/**
 * Classes that track another asset or a peg (stablecoins, tokenized stocks/ETFs/commodities/
 * treasuries, wrapped, bridged and staked tokens): never screened, never in the market median.
 */
export const EXCLUDED_CLASSES: ReadonlySet<string> = new Set(["stablecoin", "tokenized", "wrapped", "bridged", "staked"]);

export interface UniverseFloors {
  minMarketCapUsd: number;
  minVolume24hUsd: number;
}

export interface UniverseAsset {
  assetClass: string;
  isBenchmark: boolean;
}

export interface UniverseQuote {
  price: number | null;
  marketCap: number | null;
  volumeRolling24h: number | null;
  isStale: boolean;
}

/**
 * Exclusions that more history cannot fix: class, benchmark role, missing or stale data and the
 * liquidity / circulating market-cap floors. Warm-up is decided separately from history depth.
 */
export function eligibilityExclusions(asset: UniverseAsset, latest: UniverseQuote | null, p: UniverseFloors): string[] {
  const reasons: string[] = [];
  if (EXCLUDED_CLASSES.has(asset.assetClass)) reasons.push(`excluded_class:${asset.assetClass}`);
  if (asset.isBenchmark) reasons.push("benchmark_reference");
  if (!latest) {
    reasons.push("no_current_snapshot");
    return reasons;
  }
  if (latest.isStale) reasons.push("stale_observation");
  if (latest.price === null || latest.volumeRolling24h === null) reasons.push("incomplete_data");
  if (latest.volumeRolling24h !== null && latest.volumeRolling24h < p.minVolume24hUsd) reasons.push("illiquid_volume");
  if (latest.marketCap === null) reasons.push("market_cap_unavailable");
  if (latest.marketCap !== null && latest.marketCap < p.minMarketCapUsd) reasons.push("below_min_market_cap");
  return reasons;
}

/**
 * Coins the screen evaluates (features computed, screening rows stored): benchmarks, plus
 * non-excluded classes at or above the market-cap floor. This is also the market-median
 * population (minus stale observations). Everything else can never be eligible, so it is
 * stored as raw snapshots only and summarized as exclusion counts.
 */
export function inScreenUniverse(asset: UniverseAsset, latest: Pick<UniverseQuote, "marketCap"> | null, p: UniverseFloors): boolean {
  if (asset.isBenchmark) return true;
  return !EXCLUDED_CLASSES.has(asset.assetClass) && latest?.marketCap != null && latest.marketCap >= p.minMarketCapUsd;
}

/**
 * Coins worth fetching genuine hourly history for: those that would be eligible right now if
 * they had enough consecutive snapshots, plus fresh benchmarks (needed for market context).
 */
export function wantsHistory(asset: UniverseAsset, latest: UniverseQuote | null, p: UniverseFloors): boolean {
  if (!latest || latest.isStale || latest.price === null || latest.price <= 0) return false;
  if (asset.isBenchmark) return true;
  return eligibilityExclusions(asset, latest, p).length === 0;
}

/** Count each exclusion reason (a coin can carry several). */
export function countReasons(reasonLists: Iterable<string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const list of reasonLists) for (const r of list) out[r] = (out[r] ?? 0) + 1;
  return out;
}

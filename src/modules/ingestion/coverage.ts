import { REFERENCE_IDS } from '../sources/benchmarks.js';
import type { RawObservation } from '../sources/source.types.js';
import { type BatchStatus, RULES } from '../strategy/index.js';

import { trackedExposure } from './classify.js';

export interface CoverageReport {
  providerId: string;
  isLive: boolean;
  /** Listing size reported by the latest discovery (null = unknown). */
  universeSize: number | null;
  universeComplete: boolean;
  /** Observations read and validated: every listed coin of the slot. */
  collected: number;
  /** Observations stored as snapshots: ranks 1–1200 only (`inStoredUniverse`). */
  stored: number;
  sourceListingComplete: boolean;
  coveragePct: number | null;
  /** "complete" only when the whole listing was collected; otherwise "partial" or "unknown". */
  label: 'complete' | 'partial' | 'unknown';
  stale: number;
  missingFields: Record<string, number>;
  newAssetsDuringCollection: number;
  /** Listing pages read for this slot (0 when a just-fetched discovery listing was reused). */
  pagesFetched: number;
  requestsUsed: number;
  notes: string[];
  /** Crawl batch recorded for this slot (Tier 1 input boundary). */
  batchId: string;
  batchStatus: BatchStatus;
}

/** Price-based classification evidence for one slot's observations (see `trackedExposure`). */
export function trackerEvidence(
  providerId: string,
  observations: RawObservation[],
): Map<string, string[]> {
  const ids = REFERENCE_IDS[providerId] ?? {};
  const refIds = new Set(Object.values(ids));
  const byId = new Map(observations.map((o) => [o.providerAssetId, o]));
  const refs = Object.fromEntries(
    Object.entries(ids).map(([k, id]) => [k, (id && byId.get(id)?.price) ?? null]),
  );
  const out = new Map<string, string[]>();
  for (const o of observations) {
    if (refIds.has(o.providerAssetId)) continue;
    const c = trackedExposure(
      {
        name: o.name,
        symbol: o.symbol,
        price: o.price,
        changePct24h: o.changePct24h,
        changePct7d: o.changePct7d,
      },
      refs,
    );
    if (c) out.set(o.providerAssetId, [c]);
  }
  return out;
}

/**
 * Whether an observation is stored as a snapshot (operator decision D4, ADR-0008): ranks 1–1200,
 * i.e. the Tier 1 band, the ranks the continuity check needs and the BTC/ETH benchmarks. A coin
 * ranked above 1200 or unranked is read and counted every hour (the rank comes first and fails
 * the rank rule, or is missing and fails closed) but leaves no row; it is stored again from the
 * hour it ranks 1–1200.
 */
export const inStoredUniverse = (rank: number | null): boolean =>
  rank !== null && rank >= 1 && rank <= RULES.rankMax;

/** Ranks 1..max absent from, and present more than once in, a batch (assumption A12). */
export function rankContinuity(
  ranks: Array<{ rank: number; n: number }>,
  max: number = RULES.rankMax,
): { missing: number[]; duplicates: number[] } {
  const seen = new Map(ranks.map((r) => [r.rank, r.n]));
  const missing: number[] = [];
  for (let r = 1; r <= max; r++) if (!seen.has(r)) missing.push(r);
  const duplicates = ranks
    .filter((r) => r.rank >= 1 && r.rank <= max && r.n > 1)
    .map((r) => r.rank)
    .sort((a, b) => a - b);
  return { missing, duplicates };
}

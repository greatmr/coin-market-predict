import { HOUR_MS } from "../common/time.js";
import { CmcApiError } from "../vmc/cmc-client.js";
import { SourceUnavailableError } from "../sources/http/polite-client.js";
import type { RawObservation } from "../sources/types.js";

/**
 * Minute offset of the current observation inside its slot. Historical hours are sampled at the
 * same offset so that t, t−1h and t−2h are about one hour apart. A lagged observation (observed
 * before its slot started) falls back to the start of each hour.
 */
export function slotOffsetMs(slot: Date, observedAt: Date | null): number {
  if (!observedAt) return 0;
  const d = observedAt.getTime() - slot.getTime();
  return d >= 0 && d < HOUR_MS ? d : 0;
}

/**
 * Choose at most one genuine sample for each of the `hours` UTC slots before `slot`: the sample
 * closest to `slot hour + offsetMs` (earlier wins a tie). Hours without a sample stay missing;
 * nothing is interpolated.
 */
export function alignToHourlySlots(samples: RawObservation[], slot: Date, hours: number, offsetMs: number): Array<{ slotTime: Date; raw: RawObservation }> {
  const end = slot.getTime();
  const from = end - hours * HOUR_MS;
  const best = new Map<number, { raw: RawObservation; t: number; dist: number }>();
  for (const raw of samples) {
    if (!raw.observedAt) continue;
    const t = raw.observedAt.getTime();
    if (!Number.isFinite(t) || t < from || t >= end) continue;
    const bucket = t - (((t % HOUR_MS) + HOUR_MS) % HOUR_MS);
    const dist = Math.abs(t - (bucket + offsetMs));
    const cur = best.get(bucket);
    if (!cur || dist < cur.dist || (dist === cur.dist && t < cur.t)) best.set(bucket, { raw, t, dist });
  }
  return [...best.entries()].sort(([a], [b]) => a - b).map(([bucket, v]) => ({ slotTime: new Date(bucket), raw: v.raw }));
}

/**
 * Whether a history error should stop the whole backfill: access denial, rate limiting, budget or
 * an open circuit. A transient server/network error or an unusable response skips only that coin
 * (the HTTP client already retried it; its circuit breaker opens if the source keeps failing).
 */
export function stopsBackfill(err: unknown): boolean {
  if (err instanceof SourceUnavailableError) return true;
  if (err instanceof CmcApiError) return !["invalid_response", "bad_request", "server", "network"].includes(err.kind);
  return true;
}

/** Consecutive coins with failed history requests after which the backfill gives up for this run. */
export const MAX_CONSECUTIVE_HISTORY_FAILURES = 5;

import { HOUR_MS } from "../common/time.js";
import type { ResearchTarget } from "../screening/strategy.js";
import type { Observation } from "./simulate.js";

export interface TargetOutcome {
  status: "pending" | "hit" | "miss" | "insufficient_data";
  maxReturn: number | null;
  minReturn: number | null;
  finalReturn: number | null;
  observations: number;
  hitAt: Date | null;
}

/**
 * Label a signal against a versioned research target using only observations in
 * (signalSlot, signalSlot + horizon]. A hit requires reaching minReturn before the adverse
 * excursion limit is breached, and beating the benchmark by minExcessReturn.
 */
export function evaluateTarget(
  target: ResearchTarget,
  signalSlot: Date,
  referencePrice: number,
  obsAsc: Observation[],
  benchmarkReturn: number | null,
  asOf: Date,
): TargetOutcome {
  const end = new Date(signalSlot.getTime() + target.horizonHours * HOUR_MS);
  const window = obsAsc.filter((o) => o.slotTime > signalSlot && o.slotTime <= end && o.price !== null && !o.isStale);
  const complete = asOf >= end;
  if (window.length === 0) return { status: complete ? "insufficient_data" : "pending", maxReturn: null, minReturn: null, finalReturn: null, observations: 0, hitAt: null };
  let maxR = -Infinity;
  let minR = Infinity;
  let hitAt: Date | null = null;
  let breached = false;
  for (const o of window) {
    const r = o.price! / referencePrice - 1;
    maxR = Math.max(maxR, r);
    minR = Math.min(minR, r);
    if (r <= target.maxAdverseExcursion) breached = true;
    if (!breached && !hitAt && r >= target.minReturn && benchmarkReturn !== null && r - benchmarkReturn >= target.minExcessReturn) hitAt = o.slotTime;
  }
  const finalReturn = window[window.length - 1]!.price! / referencePrice - 1;
  const coverage = window.length / target.horizonHours;
  if (hitAt) return { status: "hit", maxReturn: maxR, minReturn: minR, finalReturn, observations: window.length, hitAt };
  if (!complete) return { status: "pending", maxReturn: maxR, minReturn: minR, finalReturn, observations: window.length, hitAt: null };
  if (coverage < 0.5 || benchmarkReturn === null) return { status: "insufficient_data", maxReturn: maxR, minReturn: minR, finalReturn, observations: window.length, hitAt: null };
  return { status: "miss", maxReturn: maxR, minReturn: minR, finalReturn, observations: window.length, hitAt: null };
}

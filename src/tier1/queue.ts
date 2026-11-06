import type { DValue } from "../common/decimal.js";
import type { PassStatus } from "./constants.js";

/**
 * Review Queue order (PDF p.14): pass_3d, then pass_7d, then pass_30d with YES < NO < N/A,
 * then multiple_3d descending (valid before N/A), then CMC id ascending.
 * These are presentation rules, not a trading rule.
 */
export interface QueueKey {
  cmcId: number;
  pass3d: PassStatus;
  pass7d: PassStatus;
  pass30d: PassStatus;
  multiple3d: DValue | null;
}

const ORDER: Record<PassStatus, number> = { YES: 0, NO: 1, "N/A": 2 };

export function compareQueue(a: QueueKey, b: QueueKey): number {
  return (
    ORDER[a.pass3d] - ORDER[b.pass3d] ||
    ORDER[a.pass7d] - ORDER[b.pass7d] ||
    ORDER[a.pass30d] - ORDER[b.pass30d] ||
    compareMultipleDesc(a.multiple3d, b.multiple3d) ||
    a.cmcId - b.cmcId
  );
}

function compareMultipleDesc(a: DValue | null, b: DValue | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b.cmp(a);
}

/** Review Queue membership: ELIGIBLE with at least one YES (p.14). */
export const inReviewQueue = (r: { eligibilityStatus: string; stars: number }) => r.eligibilityStatus === "ELIGIBLE" && r.stars >= 1;

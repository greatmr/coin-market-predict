import { D, type DValue } from '../../../common/utils/decimal.js';

import { type PassStatus, RANKING } from '../strategy.constants.js';

/**
 * Review Queue ranking (Weighted Star Ranking addendum `weighted_star_v1`, operator decision D3).
 * It ranks the scanner's own results and changes none of them: stars stay the number of YES among
 * the 3d / 7d / 30d comparisons, and each YES / NO / N/A stays exactly as evaluated. The scores are
 * prioritization features, not probabilities or forecasts; these are presentation rules.
 */

export interface RankingInput {
  pass3d: PassStatus;
  pass7d: PassStatus;
  pass30d: PassStatus;
  /** Unrounded multiples; null when the comparison is N/A. */
  multiple3d: DValue | null;
  multiple7d: DValue | null;
  multiple30d: DValue | null;
}

export interface RankingScore {
  stars: number;
  /** 60 × I(3d YES) + 25 × I(7d YES) + 15 × I(30d YES); a confirmed lower bound if not complete. */
  weightedPassPoints: number;
  /** Every comparison is YES or NO (no N/A). */
  scoreComplete: boolean;
  /** 0.60 × min(m3, 3) + 0.25 × min(m7, 3) + 0.15 × min(m30, 3) when all three are valid, else null. */
  weightedStrength: DValue | null;
  /** e.g. `YES/NO/N/A` (3d / 7d / 30d). */
  passPattern: string;
}

const CAP = new D(RANKING.strengthCap);

export function rankingScore(r: RankingInput): RankingScore {
  const windows = [
    [r.pass3d, r.multiple3d, 3],
    [r.pass7d, r.multiple7d, 7],
    [r.pass30d, r.multiple30d, 30],
  ] as const;
  const scoreComplete = windows.every(([status]) => status === 'YES' || status === 'NO');
  // An N/A earns nothing and its weight is never redistributed or turned into a NO.
  const weightedPassPoints = windows.reduce(
    (sum, [status, , days]) => sum + (status === 'YES' ? RANKING.points[days] : 0),
    0,
  );
  const weightedStrength =
    scoreComplete && windows.every(([, m]) => m !== null)
      ? windows.reduce(
          (sum, [, m, days]) =>
            sum.plus(new D(RANKING.strengthWeights[days]).times(m!.gt(CAP) ? CAP : m!)),
          new D(0),
        )
      : null;
  return {
    stars: windows.filter(([status]) => status === 'YES').length,
    weightedPassPoints,
    scoreComplete,
    weightedStrength,
    passPattern: windows.map(([status]) => status).join('/'),
  };
}

/** The sort keys of one queue row, all from the same scan of one crawl batch. */
export interface QueueKey {
  cmcId: number;
  stars: number;
  weightedPassPoints: number;
  scoreComplete: boolean;
  /** Unrounded. */
  weightedStrength: DValue | null;
  /** Unrounded, uncapped. */
  multiple3d: DValue | null;
}

/**
 * Review Queue order (weighted_star_v1): stars descending — every 3-star row before every 2-star
 * row, and so on — then weighted points descending, a complete score before an incomplete one,
 * weighted strength descending (null last), the raw 3-day multiple descending (null last), and CMC
 * id ascending. Points never override stars: a 2-star 40-point row precedes a 1-star 60-point row.
 */
export function compareQueue(a: QueueKey, b: QueueKey): number {
  return (
    b.stars - a.stars ||
    b.weightedPassPoints - a.weightedPassPoints ||
    Number(b.scoreComplete) - Number(a.scoreComplete) ||
    compareDesc(a.weightedStrength, b.weightedStrength) ||
    compareDesc(a.multiple3d, b.multiple3d) ||
    a.cmcId - b.cmcId
  );
}

/** Larger first; a missing value after every number. */
function compareDesc(a: DValue | null, b: DValue | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b.cmp(a);
}

/** Review Queue membership: ELIGIBLE with at least one YES (p.14). */
export const inReviewQueue = (r: { eligibilityStatus: string; stars: number }) =>
  r.eligibilityStatus === 'ELIGIBLE' && r.stars >= 1;

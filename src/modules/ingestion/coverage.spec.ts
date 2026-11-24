import { describe, expect, it } from 'vitest';

import { inStoredUniverse, rankContinuity } from './coverage.js';

describe('rank continuity (A12)', () => {
  it('lists missing and duplicate ranks within 1–1200', () => {
    const ranks = Array.from({ length: 1200 }, (_, i) => ({ rank: i + 1, n: 1 })).filter(
      (r) => r.rank !== 500,
    );
    ranks.push({ rank: 7, n: 2 } as never);
    expect(
      rankContinuity(
        ranks
          .filter((r, i, a) => a.findIndex((x) => x.rank === r.rank) === i)
          .map((r) => (r.rank === 7 ? { rank: 7, n: 2 } : r)),
      ),
    ).toEqual({ missing: [500], duplicates: [7] });
  });
});

describe('stored universe (D4): snapshots of ranks 1–1200 only', () => {
  it('stores ranks 1 to 1200 inclusive; above 1200, unranked or invalid ranks are only counted', () => {
    expect([1, 2, 100, 101, 1199, 1200].map(inStoredUniverse)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect([1201, 5000, 0, -1, null].map(inStoredUniverse)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

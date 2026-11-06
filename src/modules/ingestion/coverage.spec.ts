import { describe, expect, it } from 'vitest';

import { rankContinuity } from './coverage.js';

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

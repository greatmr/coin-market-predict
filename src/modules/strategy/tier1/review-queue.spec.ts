import { describe, expect, it } from 'vitest';

import { completedDates } from '../../../common/utils/dates.js';
import { D, type DValue } from '../../../common/utils/decimal.js';

import { RANKING, RANKING_RULESET_VERSION } from '../strategy.constants.js';

import {
  type QueueKey,
  type RankingInput,
  compareQueue,
  inReviewQueue,
  rankingScore,
} from './review-queue.js';
import { type CurrentResult, type DailyInput, compare, evaluateVmc } from './vmc.js';

const str = (x: DValue | null) => (x === null ? null : x.toFixed());

/**
 * The scanner's comparisons for one current VMC against the 3 / 7 / 30-day means (null = N/A),
 * through the real pass rule; the means are chosen so that every multiple is an exact decimal.
 */
function scanned(current: string, means: [string | null, string | null, string | null]) {
  const cur: CurrentResult = { status: 'OK', reason: null, vmc: new D(current), quoteAgeMs: 0 };
  const [c3, c7, c30] = means.map((m) =>
    compare(cur, {
      mean: m === null ? null : new D(m),
      reason: m === null ? 'DAILY_ROW_MISSING' : null,
    }),
  ) as [ReturnType<typeof compare>, ReturnType<typeof compare>, ReturnType<typeof compare>];
  return {
    pass3d: c3.status,
    pass7d: c7.status,
    pass30d: c30.status,
    multiple3d: c3.multiple,
    multiple7d: c7.multiple,
    multiple30d: c30.multiple,
  } satisfies RankingInput;
}

function key(cmcId: number, r: RankingInput): QueueKey {
  const s = rankingScore(r);
  return {
    cmcId,
    stars: s.stars,
    weightedPassPoints: s.weightedPassPoints,
    scoreComplete: s.scoreComplete,
    weightedStrength: s.weightedStrength,
    multiple3d: r.multiple3d,
  };
}

// Addendum § 6 acceptance cases.
const CASE1 = scanned('0.4114', ['0.187', '0.242', '0.374']); // 2.2 / 1.7 / 1.1
const CASE2 = scanned('0.224', ['0.14', '0.14', '0.16']); // 1.6 / 1.6 / 1.4
const NYY = scanned('0.2016', ['0.144', '0.126', '0.112']); // 1.4 / 1.6 / 1.8
const YNN = scanned('0.24', ['0.12', '0.2', '0.24']); // 2.0 / 1.2 / 1.0
const AYY = scanned('0.2016', [null, '0.126', '0.112']); // N/A / 1.6 / 1.8

describe('weighted star ranking: scores (addendum § 2, § 6)', () => {
  it('is versioned apart from the calculation ruleset, with 60 / 25 / 15 points', () => {
    expect(RANKING_RULESET_VERSION).toBe('weighted_star_v1');
    expect(RANKING.points).toEqual({ 3: 60, 7: 25, 30: 15 });
  });

  it('2.2 / 1.7 / 1.1 → YES/YES/NO, 2 stars, 85 points, strength 1.91', () => {
    expect([CASE1.pass3d, CASE1.pass7d, CASE1.pass30d]).toEqual(['YES', 'YES', 'NO']);
    const s = rankingScore(CASE1);
    expect([s.stars, s.weightedPassPoints, s.scoreComplete, str(s.weightedStrength)]).toEqual([
      2,
      85,
      true,
      '1.91',
    ]);
    expect(s.passPattern).toBe('YES/YES/NO');
  });

  it('1.6 / 1.6 / 1.4 → YES/YES/NO, 2 stars, 85 points, strength 1.57', () => {
    const s = rankingScore(CASE2);
    expect([CASE2.pass3d, CASE2.pass7d, CASE2.pass30d]).toEqual(['YES', 'YES', 'NO']);
    expect([s.stars, s.weightedPassPoints, str(s.weightedStrength)]).toEqual([2, 85, '1.57']);
  });

  it('an N/A earns no points, stays N/A, makes the score an incomplete lower bound and the strength NULL', () => {
    expect([AYY.pass3d, AYY.pass7d, AYY.pass30d]).toEqual(['N/A', 'YES', 'YES']);
    const s = rankingScore(AYY);
    expect([s.stars, s.weightedPassPoints, s.scoreComplete, s.weightedStrength]).toEqual([
      2,
      40,
      false,
      null,
    ]);
    expect(s.passPattern).toBe('N/A/YES/YES');
    // Its 60 points are never redistributed to the other windows.
    expect(rankingScore(NYY).weightedPassPoints).toBe(40);
  });

  it('exactly 1.5 passes; a 3-day multiple of 10 counts as 3.0 only inside the strength', () => {
    const exact = scanned('0.15', ['0.1', '0.1', '0.1']);
    expect([exact.pass3d, str(exact.multiple3d)]).toEqual(['YES', '1.5']);
    const big = scanned('1', ['0.1', '0.5', '0.5']); // 10 / 2 / 2
    const s = rankingScore(big);
    expect(str(big.multiple3d)).toBe('10');
    // 0.60 × 3.0 = 1.80, + 0.25 × 2 + 0.15 × 2
    expect(str(s.weightedStrength)).toBe('2.6');
    expect(str(new D(RANKING.strengthWeights[3]).times(RANKING.strengthCap))).toBe('1.8');
  });

  it('gives every complete pass pattern its documented points (§ 4)', () => {
    const p = (a: string, b: string, c: string) =>
      rankingScore({
        pass3d: a as 'YES' | 'NO',
        pass7d: b as 'YES' | 'NO',
        pass30d: c as 'YES' | 'NO',
        multiple3d: new D(1),
        multiple7d: new D(1),
        multiple30d: new D(1),
      });
    expect(
      [
        ['YES', 'YES', 'YES'],
        ['YES', 'YES', 'NO'],
        ['YES', 'NO', 'YES'],
        ['NO', 'YES', 'YES'],
        ['YES', 'NO', 'NO'],
        ['NO', 'YES', 'NO'],
        ['NO', 'NO', 'YES'],
        ['NO', 'NO', 'NO'],
      ].map(([a, b, c]) => {
        const s = p(a!, b!, c!);
        return [s.stars, s.weightedPassPoints];
      }),
    ).toEqual([
      [3, 100],
      [2, 85],
      [2, 75],
      [2, 40],
      [1, 60],
      [1, 25],
      [1, 15],
      [0, 0],
    ]);
  });

  it('the 14-day mean has no effect on stars, points or ranking', () => {
    const asOf = new Date('2026-11-10T10:00:00Z');
    const days = completedDates(asOf, 30);
    const rows = (shift: boolean) =>
      new Map<string, DailyInput>(
        days.map((d, i) => {
          // Moving 0.01 from day 20 to day 10 changes only the 14-day mean (3/7/30 stay 0.1).
          const vmc = shift && i === 9 ? '0.11' : shift && i === 19 ? '0.09' : '0.1';
          return [
            d,
            { dateUtc: d, volume: new D(vmc).times(1e6), marketCap: new D(1e6), valid: true },
          ];
        }),
      );
    const current = {
      present: true,
      volume24h: new D(200_000),
      marketCap: new D(1e6),
      capProviderReported: true,
      observedAt: asOf,
      collectedAt: asOf,
      sameObservation: true,
    };
    const score = (shift: boolean) => {
      const ev = evaluateVmc(asOf, rows(shift), current, 7_200_000);
      return {
        mean14: str(ev.windows[14].mean),
        rank: rankingScore({
          pass3d: ev.comparisons[3].status,
          pass7d: ev.comparisons[7].status,
          pass30d: ev.comparisons[30].status,
          multiple3d: ev.comparisons[3].multiple,
          multiple7d: ev.comparisons[7].multiple,
          multiple30d: ev.comparisons[30].multiple,
        }),
      };
    };
    const a = score(false);
    const b = score(true);
    expect(a.mean14).not.toBe(b.mean14);
    expect({ ...b.rank, weightedStrength: str(b.rank.weightedStrength) }).toEqual({
      ...a.rank,
      weightedStrength: str(a.rank.weightedStrength),
    });
  });
});

describe('weighted star ranking: Review Queue order (addendum § 3, § 6)', () => {
  it('case 1 (strength 1.91) ranks ahead of case 2 (1.57) at equal stars and points', () => {
    expect([key(2, CASE2), key(1, CASE1)].sort(compareQueue).map((k) => k.cmcId)).toEqual([1, 2]);
  });

  it('a 2-star 40-point row precedes a 1-star 60-point row: points never override stars', () => {
    expect([key(1, YNN), key(2, NYY)].sort(compareQueue).map((k) => k.cmcId)).toEqual([2, 1]);
  });

  it('a complete NO/YES/YES precedes N/A/YES/YES on the completeness tie-break', () => {
    expect([key(1, AYY), key(2, NYY)].sort(compareQueue).map((k) => k.cmcId)).toEqual([2, 1]);
  });

  it('groups by stars, then points: 100 | 85, 75, 40 | 60, 25, 15', () => {
    const m = (s: string) => (s === 'YES' ? new D(2) : new D(1));
    const row = (id: number, a: 'YES' | 'NO', b: 'YES' | 'NO', c: 'YES' | 'NO') =>
      key(id, {
        pass3d: a,
        pass7d: b,
        pass30d: c,
        multiple3d: m(a),
        multiple7d: m(b),
        multiple30d: m(c),
      });
    const rows = [
      row(1, 'NO', 'NO', 'YES'),
      row(2, 'YES', 'NO', 'NO'),
      row(3, 'NO', 'YES', 'YES'),
      row(4, 'YES', 'YES', 'YES'),
      row(5, 'NO', 'YES', 'NO'),
      row(6, 'YES', 'NO', 'YES'),
      row(7, 'YES', 'YES', 'NO'),
    ];
    expect(rows.sort(compareQueue).map((k) => [k.stars, k.weightedPassPoints])).toEqual([
      [3, 100],
      [2, 85],
      [2, 75],
      [2, 40],
      [1, 60],
      [1, 25],
      [1, 15],
    ]);
  });

  it('then the raw 3-day multiple (NULL last), then CMC id: identical inputs always sort the same', () => {
    const base = {
      stars: 2,
      weightedPassPoints: 40,
      scoreComplete: false,
      weightedStrength: null,
    } as const;
    const rows: QueueKey[] = [
      { ...base, cmcId: 30, multiple3d: null },
      { ...base, cmcId: 20, multiple3d: new D('1.2') },
      { ...base, cmcId: 10, multiple3d: null },
      { ...base, cmcId: 40, multiple3d: new D('1.4') },
    ];
    const order = [40, 20, 10, 30];
    expect([...rows].sort(compareQueue).map((k) => k.cmcId)).toEqual(order);
    expect(
      [...rows]
        .reverse()
        .sort(compareQueue)
        .map((k) => k.cmcId),
    ).toEqual(order);
  });

  it('queue = ELIGIBLE with at least one YES; 0-star eligible rows stay out of the queue only', () => {
    expect(inReviewQueue({ eligibilityStatus: 'ELIGIBLE', stars: 1 })).toBe(true);
    expect(inReviewQueue({ eligibilityStatus: 'ELIGIBLE', stars: 0 })).toBe(false);
    expect(inReviewQueue({ eligibilityStatus: 'NEEDS_REVIEW', stars: 3 })).toBe(false);
  });
});

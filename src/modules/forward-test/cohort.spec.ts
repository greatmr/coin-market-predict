import { describe, expect, it } from 'vitest';

import { D, type DValue } from '../../common/utils/decimal.js';

import { type CohortEvent, cohortReport, quantile, stats } from './cohort.js';
import { eventWindow } from './forward-rules.js';
import type { ForwardEventStatus } from './forward.constants.js';

const d = (x: string | number) => new D(x);
const str = (x: DValue | null) => (x === null ? null : x.toFixed());

let seq = 0;
function ev(
  stars: number,
  cmcId: number,
  detectedAt: string,
  status: ForwardEventStatus,
  ret: string | null,
): CohortEvent {
  const w = eventWindow(new Date(detectedAt));
  return {
    eventId: `e${++seq}`,
    cmcId,
    stars,
    detectedAt: w.detectedAt,
    detectedUtcDate: w.detectedUtcDate,
    evaluationEnd: w.evaluationEnd,
    status,
    peakKind: ret === null ? 'NONE' : status === 'FINAL' ? 'EXACT' : 'LOWER_BOUND',
    peakReturnPct: ret === null ? null : d(ret),
    effectiveHorizonHours: w.effectiveHorizonHours,
  };
}

describe('quantiles (type 7, exact)', () => {
  it('interpolates between order statistics', () => {
    const xs = ['1', '2', '3', '4'].map(d);
    expect(str(quantile(xs, 0.25))).toBe('1.75');
    expect(str(quantile(xs, 0.5))).toBe('2.5');
    expect(str(quantile(xs, 0.75))).toBe('3.25');
    expect(str(quantile([d(7)], 0.75))).toBe('7');
    expect(quantile([], 0.5)).toBeNull();
  });

  it('summarizes without floats', () => {
    const s = stats(['0.1', '0.2', '0.3'].map(d));
    expect([s.n, str(s.mean), str(s.median), str(s.min), str(s.max)]).toEqual([
      3,
      '0.2',
      '0.2',
      '0.1',
      '0.3',
    ]);
  });
});

describe('star-group report (p.9)', () => {
  const events = [
    // CMC 123 on 10 Nov: 2 stars then 3 stars (overlapping windows, correlated), 2 stars on 11 Nov.
    ev(2, 123, '2026-11-10T10:00:00Z', 'FINAL', '50'),
    ev(3, 123, '2026-11-10T15:00:00Z', 'FINAL', '20'),
    ev(2, 123, '2026-11-11T09:00:00Z', 'INCOMPLETE', '10'),
    ev(2, 456, '2026-11-10T22:00:00Z', 'FINAL', '-2'),
    ev(1, 789, '2026-11-12T00:00:00Z', 'TRACKING', '5'),
    ev(1, 790, '2026-11-12T03:00:00Z', 'OPEN', null),
    ev(3, 791, '2026-11-12T03:30:00Z', 'AWAITING_FINAL_DAY', '100'),
  ];
  const r = cohortReport(events);
  const g = (k: string) => r.groups.find((x) => x.group === k)!;

  it('counts events and distinct assets separately', () => {
    expect([g('2').events, g('2').distinctAssets]).toEqual([3, 2]);
    expect([g('all').events, g('all').distinctAssets]).toEqual([7, 5]);
  });

  it('uses only FINAL events in the primary aggregates; pending and incomplete are counted', () => {
    const two = g('2');
    expect([two.final, two.incomplete, two.pending]).toEqual([2, 1, 0]);
    expect(two.finalReturns.n).toBe(2);
    expect(str(two.finalReturns.mean)).toBe('24');
    expect(str(two.finalReturns.median)).toBe('24');
    expect([str(two.finalReturns.min), str(two.finalReturns.max)]).toEqual(['-2', '50']);
    const one = g('1');
    expect([one.final, one.pending, one.finalReturns.n, one.finalReturns.mean]).toEqual([
      0,
      2,
      0,
      null,
    ]);
    // An AWAITING 100 % never reaches the 3-star aggregates.
    expect(g('3').finalReturns.n).toBe(1);
    expect(str(g('3').finalReturns.max)).toBe('20');
  });

  it('bins the final returns for the distribution', () => {
    const counts = Object.fromEntries(g('2').returnDistribution.map((b) => [b.label, b.count]));
    expect(counts).toMatchObject({ '< 0 %': 1, '50 – 100 %': 1, '0 – 5 %': 0 });
  });

  it('shows detection hours and effective horizons (the extension varies by signal time)', () => {
    const hours = g('all').detectionHourUtc;
    expect([hours[10], hours[15], hours[3], hours[0]]).toEqual([1, 1, 2, 1]);
    expect(str(g('1').horizonHours.max)).toBe('192');
    // 10:00 → 182 h, 09:00 → 183 h, 22:00 → 170 h.
    expect(
      Object.fromEntries(g('2').horizonHours.bins.map((b) => [b.label, b.count])),
    ).toMatchObject({ '180 – 184 h': 2, '184 – 188 h': 0, '168 – 172 h': 1 });
  });

  it('identifies correlated observations instead of treating them as independent', () => {
    const all = g('all');
    expect(all.correlation).toMatchObject({
      assetsWithMultipleEvents: 1,
      eventsOnRepeatedAssets: 3,
      sameAssetOverlaps: 3,
      datesWithMultipleEvents: 2,
      maxEventsPerDate: 3,
    });
    expect(r.overlaps.get('e1')!.sort()).toEqual(['e2', 'e3']);
    expect(r.overlaps.get('e4')).toBeUndefined();
    expect(r.assetEventCounts.get(123)).toBe(3);
  });
});

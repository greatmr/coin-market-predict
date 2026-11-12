import { describe, expect, it } from 'vitest';

import { D } from '../../common/utils/decimal.js';

import {
  type SnapshotPoint,
  changeOver,
  downsample,
  pctChange,
  priceSummary,
  slimTrace,
} from './agent-data.js';

const t0 = new Date('2026-11-01T00:00:00Z').getTime();
const point = (hour: number, price: string | null, volume = '1000'): SnapshotPoint => ({
  slotTime: new Date(t0 + hour * 3_600_000),
  observedAt: new Date(t0 + hour * 3_600_000 - 60_000),
  price: price === null ? null : new D(price),
  marketCap: new D('20000000'),
  volume24h: new D(volume),
  rank: 500,
  isStale: false,
});

describe('agent data shaping', () => {
  it('computes percentage changes exactly and rounds only the result', () => {
    expect(pctChange(new D('0.1'), new D('0.15'))).toBe('50.00');
    expect(pctChange(new D('3'), new D('1'))).toBe('-66.67');
    expect(pctChange(new D('0'), new D('1'))).toBeNull();
    expect(pctChange(null, new D('1'))).toBeNull();
  });

  it('downsamples evenly and always keeps the first and the newest observation', () => {
    const items = Array.from({ length: 721 }, (_, i) => i);
    const picked = downsample(items, 180);
    expect(picked).toHaveLength(180);
    expect([picked[0], picked.at(-1)]).toEqual([0, 720]);
    expect(downsample([1, 2, 3], 180)).toEqual([1, 2, 3]);
  });

  it('measures a change from the newest observation at or before the reference time', () => {
    const points = [point(0, '1'), point(1, null), point(24, '2'), point(48, '3')];
    expect(changeOver(points, 24)).toEqual({
      changePct: '50.00',
      since: point(24, '2').slotTime.toISOString(),
    });
    expect(changeOver(points, 48)).toEqual({
      changePct: '200.00',
      since: point(0, '1').slotTime.toISOString(),
    });
    // Not enough history: no reference within the tolerance.
    expect(changeOver(points, 72)).toEqual({ changePct: null, since: null });
  });

  it('summarizes a price series: extremes, distance from them and the volume change', () => {
    const s = priceSummary([
      point(0, '2', '100'),
      point(1, '4', '150'),
      point(2, '1', '300'),
      point(3, '3', '400'),
    ]);
    expect(s).toMatchObject({
      priced: 4,
      priceFirstUsd: '2',
      priceLastUsd: '3',
      priceChangePct: '50.00',
      highUsd: '4',
      lowUsd: '1',
      lastVsHighPct: '-25.00',
      lastVsLowPct: '200.00',
      volume24hChangePct: '300.00',
    });
  });

  it('keeps the trace fields the agent needs and drops raw venue rows', () => {
    const slim = slimTrace({
      record: {
        cmcId: 7,
        symbol: 'ABC',
        currentVmc: 0.2,
        currentStatus: 'OK',
        stars: 2,
        flags: ['F'],
        venueFlags: [],
      },
      batch: { id: 'b', isLive: true, status: 'COMPLETE' },
      windows: [
        { days: 3, mean: '0.1', pass: { multiple: '2', status: 'YES', reason: null } },
        { days: 14, mean: '0.2', pass: null },
      ],
      venues: {
        summary: { exchanges: [{ name: 'X', volumeUsd: '1', extra: 'dropped' }] },
        crawl: { pairs: [{ raw: true }] },
      },
      reviews: [{ finalDecision: 'REVIEW', rationale: 'x'.repeat(500) }],
    });
    expect(slim.coin).toMatchObject({ cmcId: 7, symbol: 'ABC' });
    expect(slim.windows).toEqual([
      {
        days: 3,
        role: undefined,
        mean: '0.1',
        meanReason: null,
        multiple: '2',
        result: 'YES',
        resultReason: null,
      },
      {
        days: 14,
        role: undefined,
        mean: '0.2',
        meanReason: null,
        multiple: null,
        result: 'context only',
        resultReason: null,
      },
    ]);
    expect(slim.venues.exchanges).toEqual([{ name: 'X', volumeUsd: '1' }]);
    expect(JSON.stringify(slim)).not.toContain('"raw"');
    expect(String(slim.humanReviews[0]!.rationale).length).toBe(401);
  });
});

import { describe, expect, it } from 'vitest';

import { D } from '../../common/utils/decimal.js';

import type { StatsRow } from './observation-stats.js';
import { summarize } from './observation-stats.js';

const H = 3_600_000;
const row = (over: Partial<StatsRow> & Pick<StatsRow, 'id' | 'cmcId'>): StatsRow => ({
  stars: 1,
  status: 'FINAL',
  eligibility: 'SPOT_ONLY',
  t0Ms: 0,
  windowEndMs: 168 * H,
  maxRisePct: new D('10'),
  maxDropPct: new D('-5'),
  ...over,
});

describe('observation summary (SYNTHETIC rows)', () => {
  it('statistics use FINAL observations only and state their denominator in events and coins', () => {
    const s = summarize([
      row({ id: 'a', cmcId: 1, maxRisePct: new D('10'), maxDropPct: new D('-4') }),
      row({
        id: 'b',
        cmcId: 1,
        stars: 2,
        t0Ms: 24 * H,
        windowEndMs: 192 * H,
        maxRisePct: new D('20'),
        maxDropPct: new D('-8'),
      }),
      row({ id: 'c', cmcId: 2, stars: 3, maxRisePct: new D('3'), maxDropPct: new D('-1') }),
      row({
        id: 'd',
        cmcId: 3,
        status: 'ACTIVE',
        maxRisePct: new D('500'),
        maxDropPct: new D('-90'),
      }),
      row({
        id: 'e',
        cmcId: 4,
        status: 'PARTIAL',
        maxRisePct: new D('77'),
        maxDropPct: new D('-2'),
      }),
      row({
        id: 'f',
        cmcId: 5,
        status: 'DATA_UNAVAILABLE',
        maxRisePct: null,
        maxDropPct: null,
        eligibility: 'SPOT_UNAVAILABLE',
      }),
    ]);
    expect(s.total).toEqual({ events: 6, coins: 5 });
    expect(s.final.events).toBe(3);
    expect(s.final.coins).toBe(2);
    expect(s.final.rise.mean!.toFixed()).toBe('11');
    expect(s.final.rise.median!.toFixed()).toBe('10');
    expect(s.final.drop.min!.toFixed()).toBe('-8');
    expect(s.provisional).toEqual({ events: 2, coins: 2 });
    expect(s.unmeasured).toEqual({ events: 1, coins: 1 });
    expect(s.final.byStars.map((g) => [g.key, g.events])).toEqual([
      ['1', 1],
      ['2', 1],
      ['3', 1],
    ]);
  });

  it('counts correlated observations: coins with several events and overlapping windows', () => {
    const s = summarize([
      row({ id: 'a', cmcId: 1, t0Ms: 0, windowEndMs: 168 * H }),
      row({ id: 'b', cmcId: 1, t0Ms: 100 * H, windowEndMs: 268 * H }),
      row({ id: 'c', cmcId: 1, t0Ms: 300 * H, windowEndMs: 468 * H }),
      row({ id: 'd', cmcId: 2 }),
    ]);
    expect(s.correlation).toEqual({
      coinsWithSeveralEvents: 1,
      eventsOfThoseCoins: 3,
      overlappingPairs: 1,
    });
  });
});

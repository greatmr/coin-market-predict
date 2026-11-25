import { describe, expect, it } from 'vitest';

import { D } from '../../common/utils/decimal.js';

import type { StatsRow } from './observation-stats.js';
import { summarize } from './observation-stats.js';
import { OBSERVATION_RULES_V1, OBSERVATION_RULES_VERSION } from './observation.constants.js';

const H = 3_600_000;
const row = (over: Partial<StatsRow> & Pick<StatsRow, 'id' | 'cmcId'>): StatsRow => ({
  stars: 1,
  status: 'FINAL',
  rulesVersion: OBSERVATION_RULES_VERSION,
  eligibility: 'SPOT_ONLY',
  startMs: 0,
  endMs: 168 * H,
  highestPct: new D('10'),
  lowestPct: new D('-5'),
  flags: [],
  ...over,
});

describe('observation summary (SYNTHETIC rows)', () => {
  it('statistics use FINAL observations of the current rules only, with event and coin denominators', () => {
    const s = summarize([
      row({ id: 'a', cmcId: 1, highestPct: new D('10'), lowestPct: new D('-4') }),
      row({
        id: 'b',
        cmcId: 1,
        stars: 2,
        startMs: 24 * H,
        endMs: 192 * H,
        highestPct: new D('20'),
        lowestPct: new D('-8'),
        flags: ['SINGLE_TRADE_LOW'],
      }),
      row({ id: 'c', cmcId: 2, stars: 3, highestPct: new D('3'), lowestPct: new D('-1') }),
      // A FINAL of the old rules is history only: never mixed into the current statistics.
      row({ id: 'v1', cmcId: 9, rulesVersion: OBSERVATION_RULES_V1, highestPct: new D('999') }),
      row({
        id: 'd',
        cmcId: 3,
        status: 'ACTIVE',
        highestPct: new D('500'),
        lowestPct: new D('-90'),
      }),
      row({
        id: 'e',
        cmcId: 4,
        status: 'PARTIAL',
        highestPct: new D('77'),
        lowestPct: new D('-2'),
      }),
      row({ id: 'n', cmcId: 6, status: 'NO_TRADES', highestPct: null, lowestPct: null }),
      row({ id: 'u', cmcId: 7, status: 'UNVERIFIABLE', highestPct: null, lowestPct: null }),
      row({
        id: 'f',
        cmcId: 5,
        status: 'DATA_UNAVAILABLE',
        highestPct: null,
        lowestPct: null,
        eligibility: 'SPOT_UNAVAILABLE',
      }),
    ]);
    expect(s.total).toEqual({ events: 9, coins: 8 });
    expect(s.final.events).toBe(3);
    expect(s.final.coins).toBe(2);
    expect(s.final.highest.mean!.toFixed()).toBe('11');
    expect(s.final.highest.median!.toFixed()).toBe('10');
    expect(s.final.lowest.min!.toFixed()).toBe('-8');
    expect(s.final.flagged.singleTrade).toEqual({ events: 1, coins: 1 });
    expect(s.provisional).toEqual({ events: 1, coins: 1 });
    expect(s.partial).toEqual({ events: 1, coins: 1 });
    expect(s.noTrades).toEqual({ events: 1, coins: 1 });
    expect(s.unverifiable).toEqual({ events: 1, coins: 1 });
    expect(s.unmeasured).toEqual({ events: 1, coins: 1 });
    expect(s.final.byStars.map((g) => [g.key, g.events])).toEqual([
      ['1', 1],
      ['2', 1],
      ['3', 1],
    ]);
  });

  it('counts correlated observations: coins with several events and overlapping windows', () => {
    const s = summarize([
      row({ id: 'a', cmcId: 1, startMs: 0, endMs: 168 * H }),
      row({ id: 'b', cmcId: 1, startMs: 100 * H, endMs: 268 * H }),
      row({ id: 'c', cmcId: 1, startMs: 300 * H, endMs: 468 * H }),
      row({ id: 'd', cmcId: 2 }),
    ]);
    expect(s.correlation).toEqual({
      coinsWithSeveralEvents: 1,
      eventsOfThoseCoins: 3,
      overlappingPairs: 1,
    });
  });
});

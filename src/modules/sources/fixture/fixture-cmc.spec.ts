import { describe, expect, it } from 'vitest';

import { FIXTURE_LISTED, FixtureCmcMarket } from './fixture-cmc.js';

describe('fixture market', () => {
  const anchor = '2026-11-05';
  const slot = new Date('2026-11-05T07:00:00Z');
  it('is deterministic and clearly synthetic (ids ≥ 990001, names marked fixture)', () => {
    const a = new FixtureCmcMarket(anchor).observations(slot);
    const b = new FixtureCmcMarket(anchor).observations(slot);
    expect(a).toEqual(b);
    expect(
      a.every((o) => Number(o.providerAssetId) >= 990001 && o.name.includes('(fixture)')),
    ).toBe(true);
    expect(new Set(a.filter((o) => o.rank !== null).map((o) => o.rank)).size).toBe(FIXTURE_LISTED);
  });
  it('daily rows are a pure function of asset and date (refreshes never invent revisions)', () => {
    const m = new FixtureCmcMarket(anchor);
    expect(m.dailyRows(990001, '2026-10-01', '2026-11-04')).toEqual(
      new FixtureCmcMarket(anchor).dailyRows(990001, '2026-10-01', '2026-11-04'),
    );
    expect(m.dailyRows(990007, '2026-10-28', '2026-11-04').map((r) => r.dateUtc)).not.toContain(
      '2026-10-31',
    );
    expect(
      m
        .observations(slot)
        .find((o) => o.symbol === 'STAL')!
        .observedAt!.getTime(),
    ).toBeLessThan(slot.getTime() - 3 * 3600_000);
    expect(m.observations(slot).find((o) => o.symbol === 'NOCAP')!.marketCap).toBeNull();
    expect(
      m
        .observations(slot)
        .filter((o) => o.symbol === 'TWIN')
        .map((o) => o.providerAssetId)
        .sort(),
    ).toEqual(['990005', '990006']);
  });
});

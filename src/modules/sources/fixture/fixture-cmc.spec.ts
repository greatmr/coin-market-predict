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

  it('lists LBank Futures and Bithumb Spot apart from the LBank Spot list (ADR-0007)', () => {
    const m = new FixtureCmcMarket(anchor);
    const perps = m.exchangePairs('lbank', ['perpetual', 'futures'], slot);
    expect(perps).toEqual(
      new FixtureCmcMarket(anchor).exchangePairs('lbank', ['perpetual', 'futures'], slot),
    );
    expect(perps.every((p) => p.category === 'perpetual' && p.exchange === 'lbank')).toBe(true);
    const futuresIds = new Set(perps.map((p) => p.baseCurrencyId));
    const spotIds = new Set(m.lbankPairs(slot).map((p) => p.baseCurrencyId));
    // Spot and Futures (YNY, TRIP), Spot only (ZERO), Futures only (NOLB): not derived from Spot.
    expect([990001, 990003].every((id) => futuresIds.has(id) && spotIds.has(id))).toBe(true);
    expect([futuresIds.has(990002), spotIds.has(990002)]).toEqual([false, true]);
    expect([futuresIds.has(990010), spotIds.has(990010)]).toEqual([true, false]);

    const bithumb = m.exchangePairs('bithumb', ['spot'], slot);
    expect(bithumb.filter((p) => p.baseCurrencyId === 990003).map((p) => p.marketPair)).toEqual([
      'TRIP/KRW',
      'TRIP/BTC',
    ]);
    // One Bithumb pair carries no CMC id under the shared ticker TWIN.
    expect(bithumb.filter((p) => p.baseSymbol === 'TWIN').map((p) => p.baseCurrencyId)).toEqual([
      null,
    ]);
    expect(m.exchangePairs('bithumb', ['perpetual'], slot)).toEqual([]);
  });
});

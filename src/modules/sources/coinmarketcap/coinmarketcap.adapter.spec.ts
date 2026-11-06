import { describe, expect, it } from 'vitest';

import { readJsonFixture as fixture } from '../../../common/testing/fixtures.js';

import { cmcCategories, parseCmcListings } from './coinmarketcap.adapter.js';

describe('CoinMarketCap parser', () => {
  it('parses documented listing fields, skips malformed rows, keeps nulls', () => {
    const r = parseCmcListings(fixture('cmc-listings-latest.json'));
    expect(r.observations).toHaveLength(3);
    expect(r.skipped).toBe(1);
    expect(r.totalCount).toBe(8049);
    const btc = r.observations.find((o) => o.providerAssetId === '1')!;
    expect(btc.price).toBe(100000.5);
    expect(btc.volume24h).toBe(30_000_000_000);
    expect(btc.observedAt?.toISOString()).toBe('2026-11-03T12:04:00.000Z');
    expect(btc.sourceUrl).toBe('https://coinmarketcap.com/currencies/bitcoin/');
    const usdt = r.observations.find((o) => o.symbol === 'USDT')!;
    expect(usdt.categories).toContain('stablecoins');
  });

  it('throws on API-level errors', () => {
    expect(() =>
      parseCmcListings({ status: { error_code: 1008, error_message: 'rate limit' }, data: [] }),
    ).toThrow(/1008/);
  });

  it('maps tags to categories', () => {
    expect(cmcCategories(['stablecoin', 'wrapped-tokens'])).toEqual([
      'stablecoins',
      'wrapped-tokens',
    ]);
  });
});

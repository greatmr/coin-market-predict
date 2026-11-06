import { describe, expect, it } from 'vitest';

import { readJsonFixture as fixture } from '../../../common/testing/fixtures.js';

import { parseCoinGeckoList, parseCoinGeckoMarkets } from './coingecko.adapter.js';

describe('CoinGecko parsers', () => {
  it('parses /coins/markets with provider change fields', () => {
    const r = parseCoinGeckoMarkets(fixture('coingecko-markets.json'));
    expect(r.rows).toBe(3);
    expect(r.skipped).toBe(1);
    const btc = r.observations[0]!;
    expect(btc.changePct1h).toBe(0.12);
    expect(btc.marketCap).toBe(1_980_000_000_000);
  });

  it('parses /coins/list platforms into chain + contract pairs and ignores empty ones', () => {
    const list = parseCoinGeckoList(fixture('coingecko-list.json'));
    expect(list.find((a) => a.providerAssetId === 'usd-coin')!.platforms).toHaveLength(2);
    expect(list.find((a) => a.providerAssetId === 'pepe-b')!.platforms).toEqual([
      { chain: 'base', contractAddress: '0x2222222222222222222222222222222222222222' },
    ]);
    // Same symbol, different provider ids: two distinct identities.
    expect(list.filter((a) => a.symbol === 'pepe').map((a) => a.providerAssetId)).toEqual([
      'pepe-a',
      'pepe-b',
    ]);
  });
});

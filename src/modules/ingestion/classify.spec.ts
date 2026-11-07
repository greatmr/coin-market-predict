import { describe, expect, it } from 'vitest';

import { classifyAsset, stricterClass } from './classify.js';

describe('asset classification', () => {
  it('uses provider categories first', () => {
    expect(
      classifyAsset({ name: 'Tether', symbol: 'USDT', categories: ['stablecoins'] }),
    ).toMatchObject({ assetClass: 'stablecoin', classSource: 'provider_category' });
    expect(
      classifyAsset({ name: 'WBTC', symbol: 'WBTC', categories: ['wrapped-tokens'] }).assetClass,
    ).toBe('wrapped');
  });
  it('falls back to name heuristics', () => {
    expect(classifyAsset({ name: 'Wrapped Bitcoin', symbol: 'WBTC' })).toMatchObject({
      assetClass: 'wrapped',
      underlyingAsset: 'bitcoin',
    });
    expect(classifyAsset({ name: 'Lido Staked ETH', symbol: 'STETH' }).assetClass).toBe('staked');
    expect(classifyAsset({ name: 'Some Coin', symbol: 'ABC' }).assetClass).toBe('regular');
  });
  it('never relaxes an exclusion on re-classification', () => {
    expect(stricterClass('regular', 'stablecoin')).toBe(true);
    expect(stricterClass('stablecoin', 'regular')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import type { VenuePair } from './lbank.js';
import { venueSummary } from './venue-summary.js';

const AS_OF = new Date('2026-11-05T07:07:00Z');
const pair = (
  base: string,
  id: number | null,
  quote = 'USDT',
  trading: string | null = null,
): VenuePair => ({
  exchange: 'lbank',
  exchangeName: 'LBank',
  marketPair: `${base}/${quote}`,
  category: 'spot',
  baseSymbol: base,
  baseCurrencyId: id,
  quoteSymbol: quote,
  quoteCurrencyId: 825,
  volumeUsd: '1000',
  volumePercent: null,
  priceUsd: null,
  lastUpdated: AS_OF.toISOString(),
  marketUrl: null,
  tradingStatus: trading,
  type: 'cex',
  flags: [],
});

describe('venue concentration (p.15): facts and flags, no cutoff, never auto-rejected', () => {
  const markets = (
    rows: Array<[string, string, string]>,
    status: 'COMPLETE' | 'INCOMPLETE' = 'COMPLETE',
    expected: number | null = rows.length,
  ) => ({
    id: 'm1',
    status,
    finishedAt: AS_OF,
    expectedCount: expected,
    fetchedCount: rows.length,
    pairs: rows.map(([exchange, vol, pct]) => ({
      ...pair('ABC', 7),
      exchange,
      exchangeName: exchange,
      volumeUsd: vol,
      volumePercent: pct,
    })),
  });
  it('flags Upbit as the top venue and a single venue; missing data stays pending', () => {
    const up = venueSummary(
      7,
      markets([
        ['upbit', '700', '70'],
        ['binance', '200', '20'],
        ['upbit', '100', '10'],
      ]),
      AS_OF,
      48 * 3_600_000,
    );
    expect(up.flags).toEqual(['UPBIT_TOP_VENUE']);
    expect(up.exchanges[0]).toMatchObject({
      exchange: 'upbit',
      pairs: 2,
      volumeUsd: '800',
      volumePercent: '80',
    });
    expect(
      venueSummary(7, markets([['lbank', '100', '100']]), AS_OF, 48 * 3_600_000).flags,
    ).toEqual(['SINGLE_VENUE']);
    expect(venueSummary(7, null, AS_OF, 1).flags).toEqual(['VENUE_DATA_PENDING']);
    const partial = venueSummary(
      7,
      markets([['lbank', '100', '10']], 'INCOMPLETE', 50),
      AS_OF,
      48 * 3_600_000,
    );
    expect(partial.flags).toEqual(['VENUE_DATA_INCOMPLETE']);
    expect(partial.flags).not.toContain('SINGLE_VENUE');
    expect(
      venueSummary(
        7,
        markets([['lbank', '1', '1']]),
        new Date(AS_OF.getTime() + 49 * 3_600_000),
        48 * 3_600_000,
      ).dataStatus,
    ).toBe('STALE');
  });
});

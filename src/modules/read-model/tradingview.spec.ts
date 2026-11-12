import { describe, expect, it } from 'vitest';

import { chartCandidates } from './tradingview.js';

const venue = (
  exchange: string,
  base: string,
  quote: string,
  volumeUsd: string,
  baseCurrencyId = 42,
) => ({
  exchange,
  exchangeName: exchange.toUpperCase(),
  baseSymbol: base,
  quoteSymbol: quote,
  baseCurrencyId,
  category: 'spot',
  volumeUsd,
});

describe('TradingView chart symbols (TradingView has no LBank Spot data)', () => {
  it('prefers spot markets CMC lists for this coin id: USD quotes first, by volume, one per exchange', () => {
    const c = chartCandidates({
      cmcId: 42,
      symbol: 'ABC',
      lbankPairs: [{ baseSymbol: 'ABC', quoteSymbol: 'USDT', mapping: 'OK' }],
      venuePairs: [
        venue('binance', 'ABC', 'TRY', '900000'),
        venue('binance', 'ABC', 'USDT', '500000'),
        venue('gate', 'ABC', 'USDT', '700000'),
        venue('coinbase-exchange', 'ABC', 'USD', '100'),
        venue('some-dex', 'ABC', 'USDT', '9000000'),
        venue('okx', 'ABC', 'USDT', '800000', 99), // another asset sharing the ticker
      ],
    });
    expect(c.map((x) => x.symbol)).toEqual([
      'GATE:ABCUSDT',
      'BINANCE:ABCUSDT',
      'COINBASE:ABCUSD',
      'LBANK:ABCUSDT.P',
      'CRYPTO:ABCUSD',
    ]);
    expect(c.map((x) => x.source)).toEqual([
      'cmc_venue',
      'cmc_venue',
      'cmc_venue',
      'lbank_perpetual',
      'ticker_index',
    ]);
  });

  it('falls back to the LBank perpetual and the ticker index, and rejects unusable tickers', () => {
    const c = chartCandidates({
      cmcId: 7,
      symbol: 'X-Y',
      lbankPairs: [{ baseSymbol: 'xy', quoteSymbol: 'USDT', mapping: 'AMBIGUOUS' }],
      venuePairs: [],
    });
    expect(c).toEqual([]);
    const d = chartCandidates({
      cmcId: 7,
      symbol: 'xy',
      lbankPairs: [{ baseSymbol: 'xy', quoteSymbol: 'USDT', mapping: 'CONFIRMED' }],
      venuePairs: [venue('binance', 'X:Y', 'USDT', '1', 7)],
    });
    expect(d.map((x) => x.symbol)).toEqual(['LBANK:XYUSDT.P', 'CRYPTO:XYUSD']);
  });
});

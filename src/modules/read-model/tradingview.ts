/**
 * TradingView symbols for a coin's live chart in the dashboard (Tier 2 is a review of TradingView's
 * 1D chart, docs/strategy-two-tier-vmc.md § 7). TradingView carries LBank perpetual futures
 * (`LBANK:<BASE>USDT.P`) but no LBank Spot markets (checked 2026-11-12), so every chart is a proxy
 * for the LBank Spot pair. Preferred: a spot market that CMC lists for this very CMC id (venue
 * rows) on an exchange TradingView carries, highest volume first, one per exchange. Then the LBank
 * perpetual and TradingView's ticker index, both labelled: a ticker alone can name another asset.
 */

/** CMC exchange slug → TradingView exchange prefix (each verified against TradingView's search). */
export const TRADINGVIEW_EXCHANGES: Readonly<Record<string, string>> = {
  binance: 'BINANCE',
  'binance-us': 'BINANCEUS',
  bingx: 'BINGX',
  bitfinex: 'BITFINEX',
  bitget: 'BITGET',
  bithumb: 'BITHUMB',
  bitkub: 'BITKUB',
  bitrue: 'BITRUE',
  bitstamp: 'BITSTAMP',
  bitvavo: 'BITVAVO',
  bybit: 'BYBIT',
  'coinbase-exchange': 'COINBASE',
  'crypto-com-exchange': 'CRYPTOCOM',
  gate: 'GATE',
  gemini: 'GEMINI',
  htx: 'HTX',
  kraken: 'KRAKEN',
  kucoin: 'KUCOIN',
  mexc: 'MEXC',
  okx: 'OKX',
  phemex: 'PHEMEX',
  poloniex: 'POLONIEX',
  upbit: 'UPBIT',
  whitebit: 'WHITEBIT',
};

const USD_QUOTES = new Set(['USDT', 'USD', 'USDC', 'FDUSD', 'USD1']);
/** TradingView tickers are upper-case letters and digits; anything else is not a usable symbol. */
const TICKER = /^[A-Z0-9]{1,24}$/;

export type ChartSource = 'cmc_venue' | 'lbank_perpetual' | 'ticker_index';

export interface ChartCandidate {
  /** Full TradingView symbol, e.g. `BINANCE:XYZUSDT`. */
  symbol: string;
  exchange: string;
  base: string;
  quote: string;
  source: ChartSource;
  label: string;
  note: string;
  volumeUsd: string | null;
}

export interface ChartInput {
  cmcId: number;
  symbol: string;
  /** LBank pairs of the Tier 1 record (`scan_result.lbank_pairs`). */
  lbankPairs: ReadonlyArray<{
    baseSymbol?: string | null;
    quoteSymbol?: string | null;
    mapping?: string | null;
  }>;
  /** CMC Markets rows of the coin (`venue_crawl.pairs`, kind asset_markets); empty when not collected. */
  venuePairs: ReadonlyArray<{
    exchange?: string | null;
    exchangeName?: string | null;
    baseSymbol?: string | null;
    quoteSymbol?: string | null;
    baseCurrencyId?: number | null;
    category?: string | null;
    volumeUsd?: string | number | null;
  }>;
}

const ticker = (s: string | null | undefined) => {
  const t = String(s ?? '')
    .trim()
    .toUpperCase();
  return TICKER.test(t) ? t : null;
};
const volume = (v: string | number | null | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Chart candidates, best first (empty only when the coin has no usable ticker at all). */
export function chartCandidates(input: ChartInput, maxVenues = 5): ChartCandidate[] {
  const venues = input.venuePairs
    .filter(
      (p) =>
        (p.category ?? 'spot') === 'spot' &&
        (p.baseCurrencyId === undefined ||
          p.baseCurrencyId === null ||
          p.baseCurrencyId === input.cmcId) &&
        !!p.exchange &&
        p.exchange in TRADINGVIEW_EXCHANGES &&
        ticker(p.baseSymbol) !== null &&
        ticker(p.quoteSymbol) !== null,
    )
    .sort((a, b) => {
      const usd =
        Number(!USD_QUOTES.has(ticker(a.quoteSymbol)!)) -
        Number(!USD_QUOTES.has(ticker(b.quoteSymbol)!));
      return usd !== 0 ? usd : volume(b.volumeUsd) - volume(a.volumeUsd);
    });
  const out: ChartCandidate[] = [];
  const seenExchange = new Set<string>();
  for (const p of venues) {
    const exchange = TRADINGVIEW_EXCHANGES[p.exchange!]!;
    if (seenExchange.has(exchange)) continue;
    seenExchange.add(exchange);
    const base = ticker(p.baseSymbol)!;
    const quote = ticker(p.quoteSymbol)!;
    out.push({
      symbol: `${exchange}:${base}${quote}`,
      exchange,
      base,
      quote,
      source: 'cmc_venue',
      label: `${p.exchangeName || exchange} ${base}/${quote}`,
      note: 'Spot market CMC lists for this CMC id (venue rows). A proxy for the LBank Spot pair, which TradingView does not carry.',
      volumeUsd: p.volumeUsd === null || p.volumeUsd === undefined ? null : String(p.volumeUsd),
    });
    if (out.length >= maxVenues) break;
  }
  const lbankBase = input.lbankPairs
    .filter((p) => p.mapping === 'OK' || p.mapping === 'CONFIRMED')
    .map((p) => ticker(p.baseSymbol))
    .find((b): b is string => b !== null);
  if (lbankBase)
    out.push({
      symbol: `LBANK:${lbankBase}USDT.P`,
      exchange: 'LBANK',
      base: lbankBase,
      quote: 'USDT',
      source: 'lbank_perpetual',
      label: `LBank ${lbankBase}USDT perpetual`,
      note: 'LBank perpetual futures, not the Spot pair; it exists only when LBank lists a perpetual for this coin.',
      volumeUsd: null,
    });
  const sym = ticker(input.symbol);
  if (sym)
    out.push({
      symbol: `CRYPTO:${sym}USD`,
      exchange: 'CRYPTO',
      base: sym,
      quote: 'USD',
      source: 'ticker_index',
      label: `TradingView index ${sym}USD`,
      note: "TradingView's aggregated index, matched by ticker only: check that it is this coin (another asset can share the ticker).",
      volumeUsd: null,
    });
  return out;
}

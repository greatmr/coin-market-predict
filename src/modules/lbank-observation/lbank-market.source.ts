import { createHash } from 'node:crypto';

import { D } from '../../common/utils/decimal.js';
import { type Clock, systemClock } from '../../common/utils/time.js';

import type { FixtureCmcMarket } from '../sources/fixture/fixture-cmc.js';
import type { PoliteHttpClient } from '../sources/http/polite-client.js';
import type { ProviderInfo } from '../sources/source.types.js';
import { LBANK } from '../strategy/index.js';

import {
  type FuturesContract,
  type FuturesMarketRow,
  type KlineResponse,
  type TradesResponse,
  parseFuturesMarketData,
  parseFuturesResponses,
  parseKlineResponse,
  parsePairsResponse,
  parseTradesResponse,
} from './kline.js';
import { lbankContractFromUrl, lbankSpotSymbolFromUrl } from './observation-rules.js';
import {
  KLINE_MAX_SIZE,
  LBANK_SPOT_PROVIDER,
  MINUTE_MS,
  PRICE_INTERVAL,
  TRADES_PAGE_SIZE,
} from './observation.constants.js';

/**
 * Where LBank Spot candles and LBank's own markets lists come from (docs/lbank-spot-observation.md
 * § 3): the official public REST API, or a synthetic fixture (offline default, labelled SYNTHETIC).
 * Read-only market data; no key, no account, no order endpoint.
 */
export interface LbankMarketSource {
  readonly id: string;
  readonly isLive: boolean;
  /** `GET /v2/kline.do?symbol&size&type=minute1&time` from `fromMs` (a whole UTC minute). */
  klines(symbol: string, fromMs: number, size: number): Promise<KlineFetch>;
  /**
   * `GET /v2/supplement/trades.do?symbol&size&time`: up to `size` (≤ 600) trades with time STRICTLY
   * AFTER `afterMs`, ascending. `afterMs` must not be in the future (LBank answers 10003).
   */
  trades(symbol: string, afterMs: number, size: number): Promise<TradesFetch>;
  /** `GET /v2/currencyPairs.do`. */
  spotPairs(): Promise<ListFetch<string>>;
  /** Futures contract list joined with 24 h volume (`/cfd/openApi/v1/pub/instrument` + `marketData`). */
  futuresContracts(): Promise<ListFetch<FuturesContract>>;
  /**
   * `GET /cfd/openApi/v1/pub/marketData?productGroup=SwapU`: one snapshot of every contract (the only
   * official Futures price source; no history). Used by the Futures sampled observation.
   */
  futuresMarketData(): Promise<FuturesMarketFetch>;
}

export type FuturesMarketFetch =
  | {
      ok: true;
      url: string;
      fetchedAt: Date;
      rows: FuturesMarketRow[];
      invalid: number;
      sha256: string;
    }
  | { ok: false; url: string; fetchedAt: Date; error: string };

export interface KlineFetch {
  url: string;
  requestedAt: Date;
  durationMs: number;
  response: KlineResponse;
}

export interface TradesFetch {
  url: string;
  requestedAt: Date;
  durationMs: number;
  response: TradesResponse;
}

export type ListFetch<T> =
  | { ok: true; url: string; fetchedAt: Date; items: T[]; sha256: string }
  | { ok: false; url: string; fetchedAt: Date; error: string };

export const LBANK_MARKET_SOURCE = Symbol('LBANK_MARKET_SOURCE');

export const LBANK_SPOT_PROVIDER_INFO: ProviderInfo = {
  id: LBANK_SPOT_PROVIDER,
  name: 'LBank public market data (Spot klines, trades, pairs; Futures contracts)',
  accessMethod: 'official_api',
  isLive: true,
  baseUrl: 'https://api.lbkex.com',
  termsUrl: 'https://www.lbank.com/docs/index.html',
  attribution: 'Data: LBank',
};

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** The official LBank public REST API through the polite client (budget, rate limit, circuit). */
export class LbankApiSource implements LbankMarketSource {
  readonly id = LBANK_SPOT_PROVIDER;
  readonly isLive = true;

  constructor(
    private readonly http: PoliteHttpClient,
    private readonly spotBase: string,
    private readonly futuresBase: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async klines(symbol: string, fromMs: number, size: number): Promise<KlineFetch> {
    const params = new URLSearchParams({
      symbol,
      size: String(Math.min(KLINE_MAX_SIZE, Math.max(1, size))),
      type: PRICE_INTERVAL,
      time: String(Math.floor(fromMs / 1000)),
    });
    const url = `${this.spotBase}/v2/kline.do?${params.toString()}`;
    const requestedAt = this.clock.now();
    const started = Date.now();
    const body = await this.http.getText(url);
    return {
      url,
      requestedAt,
      durationMs: Date.now() - started,
      response: parseKlineResponse(body),
    };
  }

  async trades(symbol: string, afterMs: number, size: number): Promise<TradesFetch> {
    const params = new URLSearchParams({
      symbol,
      size: String(Math.min(TRADES_PAGE_SIZE, Math.max(1, size))),
      time: String(Math.floor(afterMs)),
    });
    const url = `${this.spotBase}/v2/supplement/trades.do?${params.toString()}`;
    const requestedAt = this.clock.now();
    const started = Date.now();
    const body = await this.http.getText(url);
    return {
      url,
      requestedAt,
      durationMs: Date.now() - started,
      response: parseTradesResponse(body),
    };
  }

  async spotPairs(): Promise<ListFetch<string>> {
    const url = `${this.spotBase}/v2/currencyPairs.do`;
    const fetchedAt = this.clock.now();
    try {
      const r = parsePairsResponse(await this.http.getText(url));
      if (r.kind === 'error') return { ok: false, url, fetchedAt, error: r.message };
      return { ok: true, url, fetchedAt, items: r.symbols, sha256: digest(r.symbols) };
    } catch (err) {
      return { ok: false, url, fetchedAt, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async futuresContracts(): Promise<ListFetch<FuturesContract>> {
    const q = '?productGroup=SwapU';
    const url = `${this.futuresBase}/cfd/openApi/v1/pub/instrument${q}`;
    const fetchedAt = this.clock.now();
    try {
      const instruments = await this.http.getText(url);
      const market = await this.http
        .getText(`${this.futuresBase}/cfd/openApi/v1/pub/marketData${q}`)
        .catch(() => null);
      const r = parseFuturesResponses(instruments, market);
      if (r.kind === 'error') return { ok: false, url, fetchedAt, error: r.message };
      return { ok: true, url, fetchedAt, items: r.contracts, sha256: digest(r.contracts) };
    } catch (err) {
      return { ok: false, url, fetchedAt, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async futuresMarketData(): Promise<FuturesMarketFetch> {
    const url = `${this.futuresBase}/cfd/openApi/v1/pub/marketData?productGroup=SwapU`;
    try {
      const body = await this.http.getText(url);
      const fetchedAt = this.clock.now();
      const r = parseFuturesMarketData(body);
      if (r.kind === 'error') return { ok: false, url, fetchedAt, error: r.message };
      return {
        ok: true,
        url,
        fetchedAt,
        rows: r.rows,
        invalid: r.invalid,
        sha256: r.responseSha256,
      };
    } catch (err) {
      return {
        ok: false,
        url,
        fetchedAt: this.clock.now(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── Synthetic fixture ───────────────────────────────────────────────────────────────────────

const unit = (key: string): number =>
  createHash('sha256').update(key).digest().readUInt32BE(0) / 0x1_0000_0000;

/** Fixture pairs listed from this time (earlier requests return the first bars, as LBank does). */
const FIXTURE_LISTED_FROM = Date.UTC(2026, 0, 1);

/**
 * A deterministic synthetic LBank market for the fixture data source (every value SYNTHETIC): the
 * fixture's LBank Spot pairs and perpetuals, with 1-minute candles that follow LBank's documented
 * conventions (OPEN = previous CLOSE, filled minutes without trades, the current minute in progress,
 * first bars returned for a time before listing) and trades consistent with them (exclusive `time`,
 * ascending), around each coin's synthetic CMC price. Symbols containing `illiquid` trade rarely.
 */
export class FixtureLbankSource implements LbankMarketSource {
  readonly id = 'fixture';
  readonly isLive = false;

  constructor(
    private readonly market: () => Promise<FixtureCmcMarket>,
    private readonly clock: Clock = systemClock,
  ) {}

  /** LBank symbol → the fixture coin's synthetic CMC price, which the synthetic LBank pair follows. */
  private refs = new Map<string, number>();

  private async loadRefs(): Promise<void> {
    if (this.refs.size) return;
    const m = await this.market();
    for (const p of m.lbankPairs(this.clock.now())) {
      const sym = lbankSpotSymbolFromUrl(p.marketUrl);
      if (sym && p.baseCurrencyId !== null) this.refs.set(sym, m.referencePrice(p.baseCurrencyId));
    }
  }

  private price(symbol: string, minute: number): number {
    const base = this.refs.get(symbol) ?? 0.05 + 20 * unit(`p:${symbol}`);
    const day = (2 * Math.PI * minute) / 1440;
    return (
      base *
      (1 +
        0.04 * Math.sin(day + 6 * unit(`ph:${symbol}`)) +
        0.015 * Math.sin((2 * Math.PI * minute) / 97))
    );
  }

  private traded(symbol: string, minute: number): boolean {
    return !symbol.includes('illiquid') || unit(`t:${symbol}:${minute}`) < 0.05;
  }

  private lastTradePrice(symbol: string, minute: number): number {
    for (let m = minute, i = 0; i < 4000; m--, i++)
      if (this.traded(symbol, m)) return this.price(symbol, m);
    return this.price(symbol, minute);
  }

  /** O, H, L, C, V as LBank would send them (8 significant digits); the minute in progress is partial. */
  private ohlcv(
    symbol: string,
    minute: number,
    nowMs: number,
  ): [string, string, string, string, string] {
    const fmt = (n: number) => Number(n.toPrecision(8)).toString();
    const open = this.lastTradePrice(symbol, minute - 1);
    if (!this.traded(symbol, minute)) return [fmt(open), fmt(open), fmt(open), fmt(open), '0'];
    // The minute in progress has seen only part of its trades.
    const progress = Math.min(1, Math.max(0.05, (nowMs - minute * MINUTE_MS) / MINUTE_MS));
    const close = open + (this.price(symbol, minute) - open) * progress;
    const high = Math.max(open, close) * (1 + 0.002 * unit(`h:${symbol}:${minute}`) * progress);
    const low = Math.min(open, close) * (1 - 0.002 * unit(`l:${symbol}:${minute}`) * progress);
    const volume = (1 + 999 * unit(`v:${symbol}:${minute}`)) * progress;
    return [fmt(open), fmt(high), fmt(low), fmt(close), fmt(volume)];
  }

  private bar(symbol: string, minute: number, nowMs: number): Array<number | string> {
    return [minute * 60, ...this.ohlcv(symbol, minute, nowMs)];
  }

  /**
   * The trades of a closed traded minute, consistent with its candle: one at the Low (+7.123 s), one
   * at the High (+23.456 s) and one at the Close (+51.789 s); quantities sum exactly to the volume.
   * The OPEN (the previous close) is not traded, as on LBank.
   */
  private minuteTrades(symbol: string, minute: number) {
    const [, high, low, close, volume] = this.ohlcv(symbol, minute, (minute + 2) * MINUTE_MS);
    if (volume === '0') return [];
    const v = new D(volume);
    const q1 = v.times('0.25');
    const q2 = v.times('0.35');
    const q3 = v.minus(q1).minus(q2);
    const at = minute * MINUTE_MS;
    return [
      { id: `fx-${symbol}-${minute}-1`, time: at + 7_123, price: low, qty: q1.toFixed(), m: true },
      {
        id: `fx-${symbol}-${minute}-2`,
        time: at + 23_456,
        price: high,
        qty: q2.toFixed(),
        m: false,
      },
      {
        id: `fx-${symbol}-${minute}-3`,
        time: at + 51_789,
        price: close,
        qty: q3.toFixed(),
        m: true,
      },
    ];
  }

  async klines(symbol: string, fromMs: number, size: number): Promise<KlineFetch> {
    await this.loadRefs();
    const now = this.clock.now();
    const url = `fixture://lbank/v2/kline.do?symbol=${symbol}&size=${size}&type=minute1&time=${Math.floor(fromMs / 1000)}`;
    const pairs = await this.spotPairs();
    const listed = new Set(pairs.ok ? pairs.items : []);
    let body: string;
    if (!listed.has(symbol)) {
      body = JSON.stringify({
        result: 'false',
        msg: 'currency pair nonsupport',
        error_code: 10008,
        ts: now.getTime(),
      });
    } else {
      const nowMinute = Math.floor(now.getTime() / MINUTE_MS);
      const first = Math.max(Math.floor(fromMs / MINUTE_MS), FIXTURE_LISTED_FROM / MINUTE_MS);
      const data: Array<Array<number | string>> = [];
      for (let m = first; m <= nowMinute && data.length < Math.min(size, KLINE_MAX_SIZE); m++)
        data.push(this.bar(symbol, m, now.getTime()));
      body = `{"msg":"Success","result":"true","data":${JSON.stringify(data).replace(/"(-?\d[\d.e+-]*)"/g, '$1')},"error_code":0,"ts":${now.getTime()}}`;
    }
    return { url, requestedAt: now, durationMs: 0, response: parseKlineResponse(body) };
  }

  async trades(symbol: string, afterMs: number, size: number): Promise<TradesFetch> {
    await this.loadRefs();
    const now = this.clock.now();
    const url = `fixture://lbank/v2/supplement/trades.do?symbol=${symbol}&size=${size}&time=${Math.floor(afterMs)}`;
    const pairs = await this.spotPairs();
    let body: string;
    if (!new Set(pairs.ok ? pairs.items : []).has(symbol)) {
      body = JSON.stringify({
        result: 'false',
        msg: 'currency pair nonsupport',
        error_code: 10008,
        ts: now.getTime(),
      });
    } else if (afterMs > now.getTime()) {
      body = JSON.stringify({
        result: 'false',
        msg: 'Illegal parameter',
        error_code: 10003,
        ts: now.getTime(),
      });
    } else {
      const rows: string[] = [];
      const lastClosed = Math.floor(now.getTime() / MINUTE_MS) - 1;
      const limit = Math.min(size, TRADES_PAGE_SIZE);
      for (
        let m = Math.max(Math.floor(afterMs / MINUTE_MS), FIXTURE_LISTED_FROM / MINUTE_MS);
        m <= lastClosed && rows.length < limit;
        m++
      )
        for (const t of this.minuteTrades(symbol, m))
          if (t.time > afterMs && rows.length < limit)
            rows.push(
              `{"quoteQty":0,"price":${t.price},"qty":${t.qty},"id":"${t.id}","time":${t.time},"isBuyerMaker":${t.m}}`,
            );
      body = `{"msg":"Success","result":"true","data":[${rows.join(',')}],"error_code":0,"ts":${now.getTime()}}`;
    }
    return { url, requestedAt: now, durationMs: 0, response: parseTradesResponse(body) };
  }

  async spotPairs(): Promise<ListFetch<string>> {
    const fetchedAt = this.clock.now();
    const m = await this.market();
    const items = [
      ...new Set(
        m
          .lbankPairs(fetchedAt)
          .map((p) => lbankSpotSymbolFromUrl(p.marketUrl))
          .filter((s): s is string => !!s),
      ),
    ].sort();
    return {
      ok: true,
      url: 'fixture://lbank/v2/currencyPairs.do',
      fetchedAt,
      items,
      sha256: digest(items),
    };
  }

  async futuresContracts(): Promise<ListFetch<FuturesContract>> {
    const fetchedAt = this.clock.now();
    const m = await this.market();
    const items: FuturesContract[] = m
      .exchangePairs(LBANK, ['perpetual'], fetchedAt)
      .map((p) => ({
        symbol:
          lbankContractFromUrl(p.marketUrl) ?? `${p.baseSymbol}${p.quoteSymbol}`.toUpperCase(),
        base: p.baseSymbol.toUpperCase(),
        quote: p.quoteSymbol.toUpperCase(),
        volume24h: '125000.5',
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    return {
      ok: true,
      url: 'fixture://lbank/cfd/openApi/v1/pub/instrument?productGroup=SwapU',
      fetchedAt,
      items,
      sha256: digest(items),
    };
  }
  /**
   * Synthetic snapshot (labelled fixture): every fixture perpetual contract, stamped with the current
   * second; the last price follows a deterministic path and the turnover rises on odd minutes only,
   * so even minutes exercise "price without a proven trade".
   */
  async futuresMarketData(): Promise<FuturesMarketFetch> {
    const fetchedAt = this.clock.now();
    const list = await this.futuresContracts();
    if (!list.ok) return { ok: false, url: list.url, fetchedAt, error: list.error };
    const nowMs = fetchedAt.getTime();
    const minute = Math.floor(nowMs / MINUTE_MS);
    const rows: FuturesMarketRow[] = list.items.map((c) => {
      let h = 0;
      for (const ch of c.symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const base = 1 + (h % 1000) / 100;
      const price = new D(base).times(1 + Math.sin(minute / 7 + (h % 13)) / 20).toDecimalPlaces(6);
      const turnover = new D(Math.ceil(minute / 2)).times(1000).plus(h % 97);
      return {
        symbol: c.symbol,
        serverMs: Math.floor(nowMs / 1000) * 1000,
        lastPrice: price.toFixed(),
        turnover24h: turnover.toFixed(),
        volume24h: turnover.toFixed(),
        high24h: null,
        low24h: null,
        markPrice: null,
        instrumentStatus: '2',
      };
    });
    return {
      ok: true,
      url: 'fixture://lbank/cfd/openApi/v1/pub/marketData?productGroup=SwapU',
      fetchedAt,
      rows,
      invalid: 0,
      sha256: digest(rows),
    };
  }
}

import { D, type DValue, parseExactJson, sha256 } from '../../common/utils/decimal.js';

import type { Bar } from './observation-rules.js';
import { CLOSED_BAR_MARGIN_MS, MINUTE_MS } from './observation.constants.js';

/**
 * Parsing of LBank's public Spot market-data responses (docs/lbank-spot-observation.md § 3), pure.
 * Verified 2026-11-24 against api.lbkex.com:
 *  - `GET /v2/kline.do?symbol&size(1–2000)&type=minute1&time=<unix s>` returns `size` bars starting
 *    with the bar that contains `time`, ascending, one per UTC minute; minutes without trades are
 *    filled (O = H = L = C = previous close, volume 0); OPEN is the previous bar's CLOSE;
 *  - the last bar may be the minute still in progress (its H / L / C / V change until it closes);
 *  - a `time` before the pair's first trade returns the pair's first bars instead (no error);
 *  - errors come with HTTP 200 and `error_code` ≠ 0: 10008 "currency pair nonsupport" (unknown or
 *    delisted pair: no history at all), 10003 illegal parameter, 10004 too frequent, 10000 internal.
 * Numbers keep their exact JSON text (no float round trip).
 */

export const LBANK_ERROR = {
  internal: 10000,
  illegalParameter: 10003,
  tooFrequent: 10004,
  pairUnsupported: 10008,
} as const;

export interface ParsedKlines {
  kind: 'ok';
  /** The server's response time (`ts`, ms). */
  serverTsMs: number;
  /** Every well-formed bar returned, ascending, one per minute. */
  bars: Bar[];
  /** Bars closed at the server time (less CLOSED_BAR_MARGIN_MS): the only ones stored. */
  closed: Bar[];
  rows: number;
  invalid: Array<{ index: number; reason: string }>;
  duplicates: number;
  /** Rows were not in ascending time order (they are sorted here). */
  unordered: boolean;
  responseSha256: string;
}

export type KlineResponse =
  | ParsedKlines
  | {
      kind: 'unsupported';
      code: number;
      message: string;
      serverTsMs: number | null;
      responseSha256: string;
    }
  | {
      kind: 'error';
      code: number | null;
      message: string;
      serverTsMs: number | null;
      responseSha256: string;
    };

interface Envelope {
  result?: unknown;
  msg?: unknown;
  error_code?: unknown;
  ts?: unknown;
  data?: unknown;
}

const intOf = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isSafeInteger(n) ? n : null;
};

const exactNumber = (v: unknown): DValue | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const d = new D(s);
  return d.isFinite() ? d : null;
};

/** The application status of an LBank response for the HTTP client (rate limit → 429, internal → 503). */
export function lbankResponseStatus(httpStatus: number, body: string): number {
  if (httpStatus !== 200) return httpStatus;
  const m = /"error_code"\s*:\s*(\d+)/.exec(body);
  const code = m ? Number(m[1]) : 0;
  if (code === LBANK_ERROR.tooFrequent) return 429;
  if (code === LBANK_ERROR.internal) return 503;
  return httpStatus;
}

export function parseEnvelope(body: string): {
  env: Envelope | null;
  code: number | null;
  message: string;
  serverTsMs: number | null;
} {
  let env: Envelope | null;
  try {
    const v = parseExactJson(body);
    env = v && typeof v === 'object' && !Array.isArray(v) ? (v as Envelope) : null;
  } catch {
    env = null;
  }
  return {
    env,
    code: env ? intOf(env.error_code) : null,
    message: env && typeof env.msg === 'string' ? env.msg : 'not a JSON object',
    serverTsMs: env ? intOf(env.ts) : null,
  };
}

export function parseKlineResponse(body: string): KlineResponse {
  const responseSha256 = sha256(body);
  const { env, code, message, serverTsMs } = parseEnvelope(body);
  if (!env || code === null)
    return {
      kind: 'error',
      code: null,
      message: `malformed response: ${message}`,
      serverTsMs,
      responseSha256,
    };
  if (code === LBANK_ERROR.pairUnsupported)
    return { kind: 'unsupported', code, message, serverTsMs, responseSha256 };
  if (code !== 0 || !Array.isArray(env.data) || serverTsMs === null)
    return {
      kind: 'error',
      code,
      message: code !== 0 ? message : 'no data array or server time',
      serverTsMs,
      responseSha256,
    };

  const invalid: ParsedKlines['invalid'] = [];
  const parsed: Bar[] = [];
  env.data.forEach((row: unknown, index) => {
    if (!Array.isArray(row) || row.length < 6)
      return invalid.push({ index, reason: 'not a 6-field row' });
    const ts = intOf(row[0]);
    if (ts === null || ts % 60 !== 0)
      return invalid.push({ index, reason: 'time not a whole UTC minute' });
    const [open, high, low, close, volume] = row.slice(1, 6).map(exactNumber);
    if (!open || !high || !low || !close || !volume)
      return invalid.push({ index, reason: 'non-numeric value' });
    if (open.lte(0) || high.lte(0) || low.lte(0) || close.lte(0))
      return invalid.push({ index, reason: 'non-positive price' });
    if (volume.lt(0)) return invalid.push({ index, reason: 'negative volume' });
    if (high.lt(low) || close.gt(high) || close.lt(low))
      return invalid.push({ index, reason: 'inconsistent high / low / close' });
    parsed.push({ openMs: ts * 1000, open, high, low, close, volume });
  });
  let unordered = false;
  for (let i = 1; i < parsed.length; i++)
    if (parsed[i]!.openMs < parsed[i - 1]!.openMs) unordered = true;
  const sorted = [...parsed].sort((a, b) => a.openMs - b.openMs);
  const bars: Bar[] = [];
  let duplicates = 0;
  for (const b of sorted) {
    const prev = bars.at(-1);
    if (prev && prev.openMs === b.openMs) {
      duplicates++;
      continue;
    }
    bars.push(b);
  }
  const closed = bars.filter((b) => b.openMs + MINUTE_MS + CLOSED_BAR_MARGIN_MS <= serverTsMs);
  return {
    kind: 'ok',
    serverTsMs,
    bars,
    closed,
    rows: env.data.length,
    invalid,
    duplicates,
    unordered,
    responseSha256,
  };
}

/** One row of `GET /v2/supplement/trades.do`, exact, in the response's order. */
export interface TradeRow {
  id: string;
  timeMs: number;
  price: DValue;
  qty: DValue;
  buyerMaker: boolean | null;
}

export type TradesResponse =
  | {
      kind: 'ok';
      serverTsMs: number | null;
      /** Well-formed rows in the response's order (LBank: ascending time; stable inside one ms). */
      rows: TradeRow[];
      /** Rows in the response before validation (a full page has TRADES_PAGE_SIZE). */
      rowCount: number;
      invalid: Array<{ index: number; reason: string }>;
      /** Times were not ascending (the rows are kept in response order; the reader sorts). */
      unordered: boolean;
      responseSha256: string;
    }
  | {
      kind: 'unsupported';
      code: number;
      message: string;
      serverTsMs: number | null;
      responseSha256: string;
    }
  | {
      kind: 'error';
      code: number | null;
      message: string;
      serverTsMs: number | null;
      responseSha256: string;
    };

/**
 * `GET /v2/supplement/trades.do?symbol&size(1–600)&time=<unix ms>` (verified 2026-11-25): the trades
 * with time STRICTLY AFTER `time`, ascending; `time` in seconds is misread as milliseconds; a future
 * `time` answers 10003. Prices and quantities keep their exact JSON digits.
 */
export function parseTradesResponse(body: string): TradesResponse {
  const responseSha256 = sha256(body);
  const { env, code, message, serverTsMs } = parseEnvelope(body);
  if (!env || code === null)
    return {
      kind: 'error',
      code: null,
      message: `malformed response: ${message}`,
      serverTsMs,
      responseSha256,
    };
  if (code === LBANK_ERROR.pairUnsupported)
    return { kind: 'unsupported', code, message, serverTsMs, responseSha256 };
  if (code !== 0 || !Array.isArray(env.data))
    return {
      kind: 'error',
      code,
      message: code !== 0 ? message : 'no data array',
      serverTsMs,
      responseSha256,
    };
  const invalid: Array<{ index: number; reason: string }> = [];
  const rows: TradeRow[] = [];
  env.data.forEach((raw: unknown, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return invalid.push({ index, reason: 'not an object' });
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.trim()) return invalid.push({ index, reason: 'no id' });
    const timeMs = intOf(r.time);
    if (timeMs === null || timeMs <= 0) return invalid.push({ index, reason: 'no time' });
    const price = exactNumber(r.price);
    const qty = exactNumber(r.qty);
    if (!price || !qty) return invalid.push({ index, reason: 'non-numeric value' });
    if (price.lte(0)) return invalid.push({ index, reason: 'non-positive price' });
    if (qty.lte(0)) return invalid.push({ index, reason: 'non-positive quantity' });
    rows.push({
      id: r.id,
      timeMs,
      price,
      qty,
      buyerMaker: typeof r.isBuyerMaker === 'boolean' ? r.isBuyerMaker : null,
    });
  });
  let unordered = false;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.timeMs < rows[i - 1]!.timeMs) unordered = true;
  return {
    kind: 'ok',
    serverTsMs,
    rows,
    rowCount: env.data.length,
    invalid,
    unordered,
    responseSha256,
  };
}

/** `GET /v2/currencyPairs.do`: LBank's list of available Spot pairs (lower-case symbols). */
export function parsePairsResponse(
  body: string,
):
  | { kind: 'ok'; symbols: string[]; serverTsMs: number | null }
  | { kind: 'error'; message: string } {
  const { env, code, message, serverTsMs } = parseEnvelope(body);
  if (!env || code !== 0 || !Array.isArray(env.data))
    return { kind: 'error', message: `currencyPairs: ${code ?? 'no code'} ${message}` };
  const symbols = env.data
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.toLowerCase());
  if (!symbols.length) return { kind: 'error', message: 'currencyPairs: empty list' };
  return { kind: 'ok', symbols: [...new Set(symbols)].sort(), serverTsMs };
}

export interface FuturesContract {
  symbol: string;
  base: string;
  quote: string;
  /** 24 h volume from the market-data list (documented field), exact text; null when absent. */
  volume24h: string | null;
}

/**
 * LBank Futures public lists (`lbkperp.lbank.com/cfd/openApi/v1/pub/instrument` and `…/marketData`,
 * productGroup=SwapU): contracts with their base / price currency, joined with the 24 h volume.
 */
export function parseFuturesResponses(
  instrumentBody: string,
  marketBody: string | null,
): { kind: 'ok'; contracts: FuturesContract[] } | { kind: 'error'; message: string } {
  const ins = parseEnvelope(instrumentBody);
  if (!ins.env || ins.code !== 0 || !Array.isArray(ins.env.data))
    return { kind: 'error', message: `instrument: ${ins.code ?? 'no code'} ${ins.message}` };
  const volume = new Map<string, string>();
  if (marketBody) {
    const md = parseEnvelope(marketBody);
    if (md.env && md.code === 0 && Array.isArray(md.env.data))
      for (const r of md.env.data as Array<Record<string, unknown>>)
        if (
          r &&
          typeof r.symbol === 'string' &&
          (typeof r.volume === 'string' || typeof r.volume === 'number')
        )
          volume.set(r.symbol.toUpperCase(), String(r.volume));
  }
  const contracts: FuturesContract[] = [];
  for (const r of ins.env.data as Array<Record<string, unknown>>) {
    if (!r || typeof r.symbol !== 'string' || typeof r.baseCurrency !== 'string') continue;
    const symbol = r.symbol.toUpperCase();
    contracts.push({
      symbol,
      base: r.baseCurrency.toUpperCase(),
      quote: typeof r.priceCurrency === 'string' ? r.priceCurrency.toUpperCase() : '',
      volume24h: volume.get(symbol) ?? null,
    });
  }
  if (!contracts.length) return { kind: 'error', message: 'instrument: empty list' };
  contracts.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { kind: 'ok', contracts };
}

/** One contract of a `marketData` snapshot (exact decimal text; `serverMs` = `lastTime` × 1000). */
export interface FuturesMarketRow {
  symbol: string;
  /** The snapshot's refresh time (whole seconds), NOT a trade time (measured 2026-11-27). */
  serverMs: number;
  lastPrice: string;
  turnover24h: string;
  volume24h: string;
  /** LBank's own 24 h figures (window not aligned to an observation: context only). */
  high24h: string | null;
  low24h: string | null;
  markPrice: string | null;
  instrumentStatus: string | null;
}

/**
 * `GET lbkperp.lbank.com/cfd/openApi/v1/pub/marketData?productGroup=SwapU`: every contract's current
 * snapshot. Rows without a symbol, a positive last price, a turnover or a `lastTime` are dropped
 * (counted), never guessed.
 */
export function parseFuturesMarketData(
  body: string,
):
  | { kind: 'ok'; rows: FuturesMarketRow[]; invalid: number; responseSha256: string }
  | { kind: 'error'; message: string; responseSha256: string } {
  const responseSha256 = sha256(body);
  const { env, code, message } = parseEnvelope(body);
  if (!env || code !== 0 || !Array.isArray(env.data))
    return {
      kind: 'error',
      message: `marketData: ${code ?? 'no code'} ${message}`,
      responseSha256,
    };
  const rows: FuturesMarketRow[] = [];
  let invalid = 0;
  const text = (v: unknown) => exactNumber(v)?.toFixed() ?? null;
  for (const r of env.data as Array<Record<string, unknown>>) {
    const symbol = r && typeof r.symbol === 'string' ? r.symbol.toUpperCase() : null;
    const t = r ? intOf(r.lastTime) : null;
    const price = r ? exactNumber(r.lastPrice) : null;
    const turnover = r ? text(r.turnover) : null;
    const volume = r ? text(r.volume) : null;
    if (!symbol || t === null || !price || !price.gt(0) || turnover === null || volume === null) {
      invalid++;
      continue;
    }
    rows.push({
      symbol,
      serverMs: t * 1000,
      lastPrice: price.toFixed(),
      turnover24h: turnover,
      volume24h: volume,
      high24h: text(r.highestPrice),
      low24h: text(r.lowestPrice),
      markPrice: text(r.markedPrice),
      instrumentStatus:
        typeof r.instrumentStatus === 'string' || typeof r.instrumentStatus === 'number'
          ? String(r.instrumentStatus)
          : null,
    });
  }
  if (!rows.length) return { kind: 'error', message: 'marketData: no usable row', responseSha256 };
  return { kind: 'ok', rows, invalid, responseSha256 };
}

import { type Decimal, ratio, toDecimal } from "./decimal.js";
import { addDays, hourFloor, type IsoDate, isoDate } from "./window.js";

/**
 * Parsers for documented CoinMarketCap API responses (bodies parsed with parseExactJson, so
 * numeric fields are exact strings). Field semantics: docs/volume-mcap.md.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ValidatedPair {
  volume: Decimal | null;
  marketCap: Decimal | null;
  ratio: Decimal | null;
  valid: boolean;
  invalidReasons: string[];
}

/**
 * Validation contract (PDF p.7): reject missing values and market cap ≤ 0; also non-finite or
 * negative values. A valid zero volume yields a zero ratio.
 */
export function validatePair(volumeRaw: unknown, marketCapRaw: unknown): ValidatedPair {
  const reasons: string[] = [];
  const v = toDecimal(volumeRaw);
  const m = toDecimal(marketCapRaw);
  if (v.reason) reasons.push(`volume_${v.reason}`);
  else if (v.value!.isNegative()) reasons.push("volume_negative");
  if (m.reason) reasons.push(`market_cap_${m.reason}`);
  else if (m.value!.isZero()) reasons.push("market_cap_zero");
  else if (m.value!.isNegative()) reasons.push("market_cap_negative");
  const valid = reasons.length === 0;
  return { volume: v.value, marketCap: m.value, ratio: valid ? ratio(v.value!, m.value!) : null, valid, invalidReasons: reasons };
}

/** Quote currency object: `quote.USD` (object form) or an element with symbol "USD" (array form). */
function usdQuote(q: unknown): Obj | null {
  if (isObj(q)) return isObj(q.USD) ? q.USD : null;
  if (Array.isArray(q)) return (q.find((x) => isObj(x) && (x.symbol === "USD" || x.id === 2781 || x.id === "2781")) as Obj) ?? null;
  return null;
}

function time(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface CmcStatus {
  errorCode: number;
  errorMessage: string | null;
  creditCount: number | null;
}

export function parseStatus(body: unknown): CmcStatus | null {
  if (!isObj(body) || !isObj(body.status)) return null;
  const s = body.status;
  const code = Number(s.error_code ?? 0);
  return { errorCode: Number.isFinite(code) ? code : -1, errorMessage: (s.error_message as string) ?? null, creditCount: s.credit_count === undefined ? null : Number(s.credit_count) };
}

export interface DailyRow extends ValidatedPair {
  cmcId: number;
  dateUtc: IsoDate;
  sourceTimestamp: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  sourceFields: Obj;
}

export interface HourlyRow extends ValidatedPair {
  cmcId: number;
  hourBucket: Date;
  observedAt: Date;
  sourceFields: Obj;
}

/** Entries of a v3 quotes/historical `data` map (keyed by id string), or a single entry. */
function historicalEntries(body: unknown): Array<{ id: number; quotes: unknown[] }> {
  if (!isObj(body)) return [];
  const data = body.data;
  if (!isObj(data)) return [];
  if (Array.isArray(data.quotes)) return [{ id: Number(data.id), quotes: data.quotes }];
  return Object.entries(data)
    .filter(([, v]) => isObj(v))
    .map(([k, v]) => ({ id: Number((v as Obj).id ?? k), quotes: Array.isArray((v as Obj).quotes) ? ((v as Obj).quotes as unknown[]) : [] }));
}

/**
 * /v3/cryptocurrency/quotes/historical with interval=daily ("end-of-day quote" convention).
 * The API returns the first quote available at the start of each UTC day. A quote sampled at
 * day D 00:0x carries volume_24h ending near midnight and the market cap at that time, so it
 * is assigned to the COMPLETED day D−1. Samples further than `maxOffsetMinutes` from midnight
 * are kept but marked invalid. If two samples map to one day, the earlier one is used.
 */
export function parseDailyEodQuotes(body: unknown, maxOffsetMinutes: number): { rows: DailyRow[]; duplicates: number } {
  const rows = new Map<string, DailyRow>();
  let duplicates = 0;
  for (const e of historicalEntries(body)) {
    for (const q of e.quotes) {
      if (!isObj(q)) continue;
      const usd = usdQuote(q.quote);
      const ts = time(q.timestamp) ?? time(usd?.timestamp);
      if (!ts) continue;
      const dateUtc = addDays(isoDate(ts), -1);
      const pair = validatePair(usd?.volume_24h, usd?.market_cap);
      const offsetMin = (ts.getTime() - new Date(`${isoDate(ts)}T00:00:00Z`).getTime()) / 60_000;
      if (offsetMin > maxOffsetMinutes) {
        pair.valid = false;
        pair.ratio = null;
        pair.invalidReasons.push(`sample_${Math.round(offsetMin)}min_after_midnight`);
      }
      const key = `${e.id}|${dateUtc}`;
      const prev = rows.get(key);
      if (prev) {
        duplicates++;
        if (prev.sourceTimestamp && prev.sourceTimestamp <= ts) continue;
      }
      rows.set(key, {
        cmcId: e.id,
        dateUtc,
        sourceTimestamp: ts,
        periodStart: new Date(`${dateUtc}T00:00:00Z`),
        periodEnd: ts,
        ...pair,
        sourceFields: { timestamp: q.timestamp ?? null, quote_timestamp: usd?.timestamp ?? null, volume_24h: usd?.volume_24h ?? null, market_cap: usd?.market_cap ?? null },
      });
    }
  }
  return { rows: [...rows.values()], duplicates };
}

/**
 * /v2/cryptocurrency/ohlcv/historical, time_period=daily: one record per UTC day from
 * time_open (00:00) to time_close (23:59:59.999). Uses quote.USD.volume (the day's volume)
 * and quote.USD.market_cap. Periods whose time_close is not before `now` are incomplete and
 * skipped.
 */
export function parseDailyOhlcv(body: unknown, now: Date): { rows: DailyRow[]; incompleteSkipped: number } {
  const rows: DailyRow[] = [];
  let incompleteSkipped = 0;
  for (const e of historicalEntries(body)) {
    for (const q of e.quotes) {
      if (!isObj(q)) continue;
      const open = time(q.time_open);
      const close = time(q.time_close);
      if (!open) continue;
      if (!close || close >= now) {
        incompleteSkipped++;
        continue;
      }
      const usd = usdQuote(q.quote);
      rows.push({
        cmcId: e.id,
        dateUtc: isoDate(open),
        sourceTimestamp: time(usd?.timestamp),
        periodStart: open,
        periodEnd: close,
        ...validatePair(usd?.volume, usd?.market_cap),
        sourceFields: { time_open: q.time_open, time_close: q.time_close, volume: usd?.volume ?? null, market_cap: usd?.market_cap ?? null, timestamp: usd?.timestamp ?? null },
      });
    }
  }
  return { rows, incompleteSkipped };
}

/**
 * /v3/cryptocurrency/quotes/historical with interval=hourly: the first quote in each UTC hour.
 * Bucket = the UTC hour containing the quote's own timestamp; no interpolation.
 */
export function parseHourlyHistorical(body: unknown): HourlyRow[] {
  const byKey = new Map<string, HourlyRow>();
  for (const e of historicalEntries(body)) {
    for (const q of e.quotes) {
      if (!isObj(q)) continue;
      const usd = usdQuote(q.quote);
      const ts = time(q.timestamp) ?? time(usd?.timestamp);
      if (!ts) continue;
      const bucket = hourFloor(ts);
      const key = `${e.id}|${bucket.toISOString()}`;
      const prev = byKey.get(key);
      if (prev && prev.observedAt <= ts) continue;
      byKey.set(key, {
        cmcId: e.id,
        hourBucket: bucket,
        observedAt: ts,
        ...validatePair(usd?.volume_24h, usd?.market_cap),
        sourceFields: { timestamp: q.timestamp ?? null, volume_24h: usd?.volume_24h ?? null, market_cap: usd?.market_cap ?? null },
      });
    }
  }
  return [...byKey.values()];
}

export interface LatestQuote {
  cmcId: number;
  name: string | null;
  symbol: string | null;
  slug: string | null;
  observedAt: Date | null;
  pair: ValidatedPair;
  sourceFields: Obj;
}

/** /v3/cryptocurrency/quotes/latest: `data` is an array; `quote` an array (or USD-keyed object). */
export function parseLatestQuotes(body: unknown): LatestQuote[] {
  if (!isObj(body)) return [];
  const data = Array.isArray(body.data) ? body.data : isObj(body.data) ? Object.values(body.data).flat() : [];
  const out: LatestQuote[] = [];
  for (const item of data) {
    if (!isObj(item) || item.id === undefined) continue;
    const usd = usdQuote(item.quote);
    out.push({
      cmcId: Number(item.id),
      name: (item.name as string) ?? null,
      symbol: (item.symbol as string) ?? null,
      slug: (item.slug as string) ?? null,
      observedAt: time(usd?.last_updated) ?? time(item.last_updated),
      pair: validatePair(usd?.volume_24h, usd?.market_cap),
      sourceFields: { last_updated: usd?.last_updated ?? item.last_updated ?? null, volume_24h: usd?.volume_24h ?? null, market_cap: usd?.market_cap ?? null },
    });
  }
  return out;
}

export interface MapEntry {
  cmcId: number;
  name: string;
  symbol: string;
  slug: string | null;
  isActive: boolean | null;
  firstHistoricalAt: Date | null;
  lastHistoricalAt: Date | null;
}

/** /v1/cryptocurrency/map entries. */
export function parseMap(body: unknown): MapEntry[] {
  if (!isObj(body) || !Array.isArray(body.data)) return [];
  return body.data.filter(isObj).map((e) => ({
    cmcId: Number(e.id),
    name: String(e.name ?? ""),
    symbol: String(e.symbol ?? ""),
    slug: (e.slug as string) ?? null,
    isActive: e.is_active === undefined ? null : Number(e.is_active) === 1,
    firstHistoricalAt: time(e.first_historical_data),
    lastHistoricalAt: time(e.last_historical_data),
  }));
}

export interface KeyInfo {
  creditLimitMonthly: number | null;
  rateLimitMinute: number | null;
  creditsUsedMonth: number | null;
  creditsLeftMonth: number | null;
  monthlyResetTimestamp: string | null;
}

export function parseKeyInfo(body: unknown): KeyInfo | null {
  if (!isObj(body) || !isObj(body.data)) return null;
  const plan = isObj(body.data.plan) ? body.data.plan : {};
  const usage = isObj(body.data.usage) && isObj(body.data.usage.current_month) ? body.data.usage.current_month : {};
  const n = (v: unknown) => (v === undefined || v === null ? null : Number(v));
  return {
    creditLimitMonthly: n(plan.credit_limit_monthly),
    rateLimitMinute: n(plan.rate_limit_minute),
    creditsUsedMonth: n(usage.credits_used),
    creditsLeftMonth: n(usage.credits_left),
    monthlyResetTimestamp: (plan.credit_limit_monthly_reset_timestamp as string) ?? null,
  };
}

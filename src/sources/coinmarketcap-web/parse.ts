import { CmcApiError } from "../../vmc/cmc-client.js";
import { type DailyRow, type HourlyRow, type LatestQuote, type MapEntry, parseDailyOhlcv, validatePair } from "../../vmc/cmc-parse.js";
import { parseExactJson } from "../../vmc/decimal.js";
import { hourFloor } from "../../vmc/window.js";
import { cmcCategories } from "../coinmarketcap/coinmarketcap.adapter.js";
import type { RawObservation, SourceAsset } from "../types.js";

type Obj = Record<string, unknown>;
export const object = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const invalid = (message: string): never => { throw new CmcApiError("invalid_response", `CMC website: ${message}`, null, null); };
const num = (v: unknown): number | null => (v !== null && v !== undefined && v !== "" && ["string", "number"].includes(typeof v) && Number.isFinite(Number(v)) ? Number(v) : null);
const date = (v: unknown): Date | null => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v) : null;
const idOf = (v: unknown): number => {
  const n = num(v);
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : invalid("missing or invalid coin id");
};

export function websiteData(body: unknown): Obj {
  if (!object(body) || !object(body.status) || Number(body.status.error_code) !== 0 || !object(body.data)) return invalid("invalid status or data envelope");
  return body.data;
}

/** Parse the coin page's server-rendered Next.js data, without executing page scripts. */
export function parseCoinPage(html: string, expectedId: number): Obj {
  const script = html.match(/<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!script) return invalid("coin page has no __NEXT_DATA__");
  let body: unknown;
  try { body = parseExactJson(script[1]!); } catch { return invalid("coin page contains invalid JSON"); }
  const props = object(body) && object(body.props) ? body.props : {};
  const page = object(props.pageProps) ? props.pageProps : {};
  const res = object(page.detailRes) ? page.detailRes : {};
  const detail = object(res.detail) ? res.detail : null;
  if (!detail || idOf(detail.id) !== expectedId) return invalid("coin page id does not match requested id");
  return detail;
}

export function parseWebIdentity(d: Obj, expectedId: number): MapEntry {
  if (idOf(d.id) !== expectedId || typeof d.name !== "string" || typeof d.symbol !== "string" || typeof d.slug !== "string") return invalid("coin identity missing or mismatched");
  return { cmcId: expectedId, name: d.name, symbol: d.symbol, slug: d.slug, isActive: typeof d.status === "string" ? d.status === "active" : null, firstHistoricalAt: date(d.actualTimeStart), lastHistoricalAt: date(d.latestUpdateTime) };
}

export function parseWebLatest(d: Obj, expectedId: number): LatestQuote {
  const identity = parseWebIdentity(d, expectedId);
  if (!object(d.statistics)) return invalid("coin page has no statistics");
  const s = d.statistics;
  return { ...identity, observedAt: date(d.latestUpdateTime), pair: validatePair(s.volume24h ?? d.volume, s.marketCap), sourceFields: { latestUpdateTime: d.latestUpdateTime ?? null, volume24h: s.volume24h ?? d.volume ?? null, marketCap: s.marketCap ?? null } };
}

/** Website history is completed-day OHLCV, never midnight rolling-24h quotes. */
export function parseWebDaily(body: unknown, expectedId: number, now: Date): { rows: DailyRow[]; incompleteSkipped: number } {
  const d = websiteData(body);
  if (idOf(d.id) !== expectedId || !Array.isArray(d.quotes)) return invalid("historical response id or quotes missing");
  const quotes = d.quotes.map((q) => {
    if (!object(q)) return q;
    const usd = object(q.quote) && ["2781", "USD"].includes(String(q.quote.name)) ? q.quote : {};
    return { time_open: q.timeOpen, time_close: q.timeClose, quote: { USD: { volume: usd.volume, market_cap: usd.marketCap, timestamp: usd.timestamp } } };
  });
  const parsed = parseDailyOhlcv({ data: { id: expectedId, quotes } }, now);
  const seen = new Set<string>();
  parsed.rows = parsed.rows.filter((r) => { if (seen.has(r.dateUtc)) return false; seen.add(r.dateUtc); return true; });
  return parsed;
}

/** Chart v = [USD price, rolling 24h USD volume, circulating USD market cap, ...]. */
export function parseWebHourly(body: unknown, cmcId: number, start: Date, end: Date): HourlyRow[] {
  const d = websiteData(body);
  if (!object(d.points)) return invalid("chart points missing");
  const hours = new Map<string, HourlyRow>();
  for (const [key, p] of Object.entries(d.points).sort(([a], [b]) => Number(a) - Number(b))) {
    if (!/^\d{10}$/.test(key) || !object(p) || !Array.isArray(p.v)) continue;
    const ts = new Date(Number(key) * 1000);
    if (ts < start || ts > end) continue;
    const hour = hourFloor(ts);
    if (hours.has(hour.toISOString())) continue;
    hours.set(hour.toISOString(), { cmcId, observedAt: ts, hourBucket: hour, ...validatePair(p.v[1], p.v[2]), sourceFields: { timestamp: key, volume24h: p.v[1] ?? null, marketCap: p.v[2] ?? null, chartFields: "v[1]=rolling24hVolumeUsd,v[2]=circulatingMarketCapUsd" } });
  }
  return [...hours.values()];
}

/**
 * Every genuine chart sample in [start, end] for the main feature pipeline, oldest first:
 * v = [USD price, rolling 24h USD volume, circulating USD market cap, ...]. Hourly slot
 * selection happens in ingestion; historical circulating supply is not reported here.
 */
export function parseWebMarketHistory(body: unknown, asset: SourceAsset, start: Date, end: Date): RawObservation[] {
  const data = websiteData(body);
  if (!object(data.points)) return invalid("chart points missing");
  const out: RawObservation[] = [];
  for (const [key, p] of Object.entries(data.points)) {
    if (!/^\d{10}$/.test(key) || !object(p) || !Array.isArray(p.v)) continue;
    const observedAt = new Date(Number(key) * 1000);
    if (observedAt < start || observedAt > end) continue;
    out.push({ providerAssetId: asset.providerAssetId, name: asset.name, symbol: asset.symbol, sourceUrl: asset.sourceUrl, observedAt, price: num(p.v[0]), marketCap: num(p.v[2]), volume24h: num(p.v[1]), circulatingSupply: null, fullyDilutedValuation: null, categories: asset.categories });
  }
  return out.sort((a, b) => a.observedAt!.getTime() - b.observedAt!.getTime());
}

export function parseWebListing(body: unknown): { assets: SourceAsset[]; observations: RawObservation[]; total: number; count: number; skipped: number } {
  const d = websiteData(body);
  if (!Array.isArray(d.cryptoCurrencyList) || num(d.totalCount) === null || Number(d.totalCount) < 0) return invalid("listing or totalCount missing");
  const assets: SourceAsset[] = [];
  const observations: RawObservation[] = [];
  let skipped = 0;
  for (const item of d.cryptoCurrencyList) {
    if (!object(item) || !num(item.id) || typeof item.name !== "string" || typeof item.symbol !== "string" || typeof item.slug !== "string") { skipped++; continue; }
    const q = Array.isArray(item.quotes) ? item.quotes.find((x) => object(x) && x.name === "USD") : null;
    if (!object(q)) { skipped++; continue; }
    const tags = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [];
    const sourceUrl = `https://coinmarketcap.com/currencies/${encodeURIComponent(item.slug)}/`;
    const platform = object(item.platform) ? item.platform : null;
    assets.push({ providerAssetId: String(item.id), name: item.name, symbol: item.symbol, sourceUrl, categories: cmcCategories(tags), platforms: platform && typeof platform.slug === "string" && typeof platform.token_address === "string" ? [{ chain: platform.slug, contractAddress: platform.token_address }] : [] });
    observations.push({ providerAssetId: String(item.id), name: item.name, symbol: item.symbol, sourceUrl, observedAt: date(q.lastUpdated) ?? date(item.lastUpdated), price: num(q.price), marketCap: num(q.marketCap), fullyDilutedValuation: num(q.fullyDilluttedMarketCap ?? q.fullyDilutedMarketCap), circulatingSupply: num(item.circulatingSupply), volume24h: num(q.volume24h), changePct1h: num(q.percentChange1h), changePct24h: num(q.percentChange24h), changePct7d: num(q.percentChange7d), categories: cmcCategories(tags) });
  }
  return { assets, observations, total: Number(d.totalCount), count: d.cryptoCurrencyList.length, skipped };
}

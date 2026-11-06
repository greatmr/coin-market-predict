import { isoDate } from '../../../common/utils/dates.js';

import type { VenuePair } from '../../strategy/index.js';
import { cmcCategories } from '../coinmarketcap/coinmarketcap.adapter.js';
import type { DailySourceRow, RawObservation, SourceAsset } from '../source.types.js';

import { CmcApiError } from './errors.js';

type Obj = Record<string, unknown>;
export const object = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const invalid = (message: string): never => {
  throw new CmcApiError('invalid_response', `CMC website: ${message}`, null, null);
};
const num = (v: unknown): number | null =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  ['string', 'number'].includes(typeof v) &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null;
const date = (v: unknown): Date | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v) : null;
const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
/** Exact numeric source text (bodies are parsed with parseExactJson), or null. */
const exact = (v: unknown): string | null =>
  v === null || v === undefined || v === ''
    ? null
    : typeof v === 'string' && NUMERIC.test(v.trim())
      ? v.trim()
      : typeof v === 'number' && Number.isFinite(v)
        ? String(v)
        : null;
const posInt = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

export function websiteData(body: unknown): Obj {
  if (
    !object(body) ||
    !object(body.status) ||
    Number(body.status.error_code) !== 0 ||
    !object(body.data)
  )
    return invalid('invalid status or data envelope');
  return body.data;
}

/**
 * Full website listing. Keeps the fields Tier 1 needs (`cmcRank`, `dateAdded`, raw `tags`,
 * `slug`, primary contract) next to the USD quote — the parser used to drop them (gaps G1–G3).
 * Volume and market cap come from the same `quotes[USD]` object (one observation).
 */
export function parseWebListing(body: unknown): {
  assets: SourceAsset[];
  observations: RawObservation[];
  total: number;
  count: number;
  skipped: number;
} {
  const d = websiteData(body);
  if (
    !Array.isArray(d.cryptoCurrencyList) ||
    num(d.totalCount) === null ||
    Number(d.totalCount) < 0
  )
    return invalid('listing or totalCount missing');
  const assets: SourceAsset[] = [];
  const observations: RawObservation[] = [];
  let skipped = 0;
  for (const item of d.cryptoCurrencyList) {
    if (
      !object(item) ||
      !posInt(item.id) ||
      typeof item.name !== 'string' ||
      typeof item.symbol !== 'string' ||
      typeof item.slug !== 'string'
    ) {
      skipped++;
      continue;
    }
    const q = Array.isArray(item.quotes)
      ? item.quotes.find((x) => object(x) && x.name === 'USD')
      : null;
    if (!object(q)) {
      skipped++;
      continue;
    }
    const tags = Array.isArray(item.tags)
      ? item.tags.filter((t): t is string => typeof t === 'string')
      : [];
    const sourceUrl = `https://coinmarketcap.com/currencies/${encodeURIComponent(item.slug)}/`;
    const platform =
      object(item.platform) &&
      typeof item.platform.slug === 'string' &&
      typeof item.platform.token_address === 'string'
        ? { chain: item.platform.slug, address: item.platform.token_address }
        : null;
    const id = String(posInt(item.id));
    assets.push({
      providerAssetId: id,
      name: item.name,
      symbol: item.symbol,
      sourceUrl,
      categories: cmcCategories(tags),
      platforms: platform ? [{ chain: platform.chain, contractAddress: platform.address }] : [],
    });
    observations.push({
      providerAssetId: id,
      name: item.name,
      symbol: item.symbol,
      sourceUrl,
      observedAt: date(q.lastUpdated) ?? date(item.lastUpdated),
      price: num(q.price),
      marketCap: num(q.marketCap),
      fullyDilutedValuation: num(q.fullyDilluttedMarketCap ?? q.fullyDilutedMarketCap),
      circulatingSupply: num(item.circulatingSupply),
      volume24h: num(q.volume24h),
      changePct1h: num(q.percentChange1h),
      changePct24h: num(q.percentChange24h),
      changePct7d: num(q.percentChange7d),
      categories: cmcCategories(tags),
      rank: posInt(item.cmcRank),
      dateAdded: date(item.dateAdded),
      tags,
      slug: item.slug,
      platform,
    });
  }
  return {
    assets,
    observations,
    total: Number(d.totalCount),
    count: d.cryptoCurrencyList.length,
    skipped,
  };
}

/**
 * Website daily history (Historical Data table): completed UTC days only, USD quote only, exact
 * source digits. A period that is not one whole UTC day is kept but marked invalid; the open day
 * (time_close not before `now`) is never returned.
 */
export function parseWebDaily(
  body: unknown,
  expectedId: number,
  now: Date,
): { rows: DailySourceRow[]; incompleteSkipped: number; duplicates: number } {
  const d = websiteData(body);
  if (posInt(d.id) !== expectedId || !Array.isArray(d.quotes))
    return invalid('historical response id or quotes missing');
  const rows = new Map<string, DailySourceRow>();
  let incompleteSkipped = 0;
  let duplicates = 0;
  for (const q of d.quotes) {
    if (!object(q)) continue;
    const open = date(q.timeOpen);
    const close = date(q.timeClose);
    if (!open) continue;
    if (!close || close >= now) {
      incompleteSkipped++;
      continue;
    }
    const usd = object(q.quote) && ['2781', 'USD'].includes(String(q.quote.name)) ? q.quote : null;
    const reasons: string[] = [];
    if (!usd) reasons.push('quote_not_usd');
    const dayStart = Date.UTC(open.getUTCFullYear(), open.getUTCMonth(), open.getUTCDate());
    if (open.getTime() !== dayStart || close.getTime() !== dayStart + 86_400_000 - 1)
      reasons.push('period_not_one_utc_day');
    const u = usd ?? {};
    const row: DailySourceRow = {
      cmcId: expectedId,
      dateUtc: isoDate(open),
      volume: exact(u.volume),
      marketCap: exact(u.marketCap),
      open: exact(u.open),
      high: exact(u.high),
      low: exact(u.low),
      close: exact(u.close),
      invalidReasons: reasons,
      periodStart: open,
      periodEnd: close,
      sourceCloseAt: date(u.timestamp) ?? close,
      sourceFields: {
        timeOpen: q.timeOpen ?? null,
        timeClose: q.timeClose ?? null,
        quoteName: usd ? String(usd.name) : null,
        volume: u.volume ?? null,
        marketCap: u.marketCap ?? null,
        close: u.close ?? null,
        timestamp: u.timestamp ?? null,
      },
    };
    if (u.volume !== undefined && u.volume !== null && row.volume === null)
      reasons.push('volume_not_numeric');
    if (u.marketCap !== undefined && u.marketCap !== null && row.marketCap === null)
      reasons.push('market_cap_not_numeric');
    if (rows.has(row.dateUtc)) {
      duplicates++;
      continue;
    }
    rows.set(row.dateUtc, row);
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.dateUtc.localeCompare(b.dateUtc)),
    incompleteSkipped,
    duplicates,
  };
}

/**
 * Market pairs from the exchange markets route (one exchange) or the coin markets route (one
 * coin). The base asset's CMC id comes from the source (`baseCurrencyId`): the crawler's own
 * identity mapping. CMC publishes no trading status, so `tradingStatus` is always null here.
 */
export function parseVenuePairs(body: unknown): {
  pairs: VenuePair[];
  expected: number | null;
  returned: number;
  skipped: number;
} {
  const d = websiteData(body);
  if (!Array.isArray(d.marketPairs)) return invalid('marketPairs missing');
  const pairs: VenuePair[] = [];
  let skipped = 0;
  for (const p of d.marketPairs) {
    const exchange = object(p) ? str(p.exchangeSlug) : null;
    const marketPair = object(p) ? str(p.marketPair) : null;
    if (!object(p) || !exchange || !marketPair) {
      skipped++;
      continue;
    }
    const flags = [
      truthy(p.outlierDetected) ? 'outlier_detected' : null,
      truthy(p.priceExcluded) ? 'price_excluded' : null,
      truthy(p.volumeExcluded) ? 'volume_excluded' : null,
    ].filter((x): x is string => !!x);
    pairs.push({
      exchange: exchange.toLowerCase(),
      exchangeName: str(p.exchangeName) ?? exchange,
      marketId: posInt(p.marketId),
      marketPair,
      category: str(p.category)?.toLowerCase() ?? 'unknown',
      baseSymbol: str(p.baseSymbol) ?? marketPair.split('/')[0] ?? '',
      baseCurrencyId: posInt(p.baseCurrencyId),
      quoteSymbol: str(p.quoteSymbol) ?? marketPair.split('/')[1] ?? '',
      quoteCurrencyId: posInt(p.quoteCurrencyId),
      volumeUsd: exact(p.volumeUsd),
      volumePercent: exact(p.volumePercent),
      priceUsd: exact(p.price),
      lastUpdated: date(p.lastUpdated)?.toISOString() ?? null,
      marketUrl: str(p.marketUrl),
      tradingStatus: null,
      type: str(p.type),
      flags,
    });
  }
  return { pairs, expected: num(d.numMarketPairs), returned: d.marketPairs.length, skipped };
}

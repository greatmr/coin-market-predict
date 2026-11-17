import { LBANK, type VenuePair } from '../strategy/index.js';

/**
 * Exchange listings shown with forward-test events (docs/adr/0007-exchange-listings.md): whether a
 * coin is listed in LBank's Spot markets, in LBank's Futures markets (perpetual and dated futures)
 * and in Bithumb's Spot markets. Each answer comes from that exchange's own markets list on CMC,
 * matched by CMC id (`baseCurrencyId`), never by ticker and never inferred from another list: a
 * Spot listing says nothing about Futures. A list that is missing, failed, incomplete or too old
 * verifies nothing, so the answer is UNKNOWN, never NO.
 *
 * Descriptive attributes only. Tier 1 eligibility, stars and points never read them: the LBank
 * check keeps its own list and rules (`strategy/tier1/lbank.ts`, decisions D1, D2). Pure: the
 * caller supplies the stored crawls.
 */

export const BITHUMB = 'bithumb';

export const EXCHANGE_LIST_KEYS = ['lbankSpot', 'lbankFutures', 'bithumb'] as const;
export type ExchangeListKey = (typeof EXCHANGE_LIST_KEYS)[number];

export interface ExchangeListSpec {
  key: ExchangeListKey;
  /** `venue_crawl.kind` of the stored list. */
  kind: 'lbank_spot_pairs' | 'lbank_futures_pairs' | 'bithumb_spot_pairs';
  /** CMC exchange slug. */
  exchange: string;
  /** CMC market categories that make up the list. */
  categories: readonly string[];
  label: string;
}

export const EXCHANGE_LISTS: Readonly<Record<ExchangeListKey, ExchangeListSpec>> = {
  lbankSpot: {
    key: 'lbankSpot',
    kind: 'lbank_spot_pairs',
    exchange: LBANK,
    categories: ['spot'],
    label: 'LBank Spot',
  },
  // LBank's Futures are perpetual contracts on CMC ("futures", dated contracts, is read as well and
  // was empty when checked on 2026-11-17).
  lbankFutures: {
    key: 'lbankFutures',
    kind: 'lbank_futures_pairs',
    exchange: LBANK,
    categories: ['perpetual', 'futures'],
    label: 'LBank Futures',
  },
  bithumb: {
    key: 'bithumb',
    kind: 'bithumb_spot_pairs',
    exchange: BITHUMB,
    categories: ['spot'],
    label: 'Bithumb',
  },
};

/** Lists fetched by the `venues` stage. The LBank Spot list keeps its own stage and cadence (D2). */
export const EXTRA_EXCHANGE_LISTS: readonly ExchangeListSpec[] = [
  EXCHANGE_LISTS.lbankFutures,
  EXCHANGE_LISTS.bithumb,
];

/** A failed or incomplete fetch is retried after this long (or the refresh period, if shorter). */
export const LIST_RETRY_MS = 6 * 3_600_000;

/** Requests a list fetch may need (pages of 500, one sweep per category); checked against the reserve. */
export const LIST_REQUEST_ALLOWANCE = 4;

/**
 * VERIFIED: a complete list no older than its maximum age. Every other state verifies nothing:
 * STALE (complete but too old), INCOMPLETE / FAILED (the latest attempt, with no complete list),
 * NOT_FETCHED (never attempted), UNSUPPORTED (the data source has no exchange markets lists).
 */
export type ListStatus =
  'VERIFIED' | 'STALE' | 'INCOMPLETE' | 'FAILED' | 'NOT_FETCHED' | 'UNSUPPORTED';
export type Listed = 'YES' | 'NO' | 'UNKNOWN';

export interface StoredList {
  id: string;
  status: 'COMPLETE' | 'INCOMPLETE' | 'FAILED';
  finishedAt: Date;
  fetchedCount: number;
  error: string | null;
}

export interface ListView {
  key: ExchangeListKey;
  label: string;
  status: ListStatus;
  /** The complete list read (VERIFIED or STALE). */
  crawlId: string | null;
  fetchedAt: Date | null;
  /** When that list stops verifying anything. */
  staleAt: Date | null;
  /** Pairs stored in that list. */
  pairs: number;
  /** The latest attempt when it is not the list read (a later failure, or the only attempt). */
  lastAttempt: { at: Date; status: string; error: string | null } | null;
  /** CMC id → market pairs listed for it (VERIFIED only). */
  listed: ReadonlyMap<number, readonly string[]>;
  /** Upper-case base tickers of listed pairs without a CMC id (VERIFIED only). */
  unmappedTickers: ReadonlySet<string>;
}

/** The answer a list can give, from the latest complete list and the latest attempt of its kind. */
export function listView(
  spec: ExchangeListSpec,
  complete: (StoredList & { pairs: readonly VenuePair[] }) | null,
  attempt: StoredList | null,
  now: Date,
  maxAgeMs: number,
  supported: boolean,
): ListView {
  const nothing = {
    key: spec.key,
    label: spec.label,
    lastAttempt:
      attempt && attempt.id !== complete?.id
        ? { at: attempt.finishedAt, status: attempt.status, error: attempt.error }
        : null,
    listed: new Map<number, readonly string[]>(),
    unmappedTickers: new Set<string>(),
  };
  if (!supported)
    return {
      ...nothing,
      status: 'UNSUPPORTED',
      crawlId: null,
      fetchedAt: null,
      staleAt: null,
      pairs: 0,
    };
  if (!complete)
    return {
      ...nothing,
      status:
        attempt?.status === 'INCOMPLETE'
          ? 'INCOMPLETE'
          : attempt?.status === 'FAILED'
            ? 'FAILED'
            : 'NOT_FETCHED',
      crawlId: null,
      fetchedAt: null,
      staleAt: null,
      pairs: 0,
    };
  const read = {
    crawlId: complete.id,
    fetchedAt: complete.finishedAt,
    staleAt: new Date(complete.finishedAt.getTime() + maxAgeMs),
    pairs: complete.fetchedCount,
  };
  if (now.getTime() - complete.finishedAt.getTime() > maxAgeMs)
    return { ...nothing, ...read, status: 'STALE' };
  const categories = new Set(spec.categories);
  const listed = new Map<number, string[]>();
  const unmappedTickers = new Set<string>();
  for (const p of complete.pairs) {
    if (p.exchange !== spec.exchange || !categories.has(p.category)) continue;
    if (p.baseCurrencyId === null) {
      unmappedTickers.add(p.baseSymbol.toUpperCase());
      continue;
    }
    const pairs = listed.get(p.baseCurrencyId);
    if (!pairs) listed.set(p.baseCurrencyId, [p.marketPair]);
    else if (!pairs.includes(p.marketPair)) pairs.push(p.marketPair);
  }
  return { ...nothing, ...read, status: 'VERIFIED', listed, unmappedTickers };
}

/** Reason codes of an UNKNOWN answer. */
export const UNKNOWN_REASON = {
  STALE: 'LIST_STALE',
  INCOMPLETE: 'LIST_INCOMPLETE',
  FAILED: 'LIST_FAILED',
  NOT_FETCHED: 'LIST_NOT_FETCHED',
  UNSUPPORTED: 'LIST_UNSUPPORTED',
  /** A listed pair without a CMC id carries this coin's ticker: it may be this coin. */
  unmappedPair: 'UNMAPPED_PAIR_SAME_TICKER',
} as const;

export interface Availability {
  status: Listed;
  /** Market pairs the list has for this CMC id (YES only). */
  pairs: readonly string[];
  /** Why the answer is UNKNOWN (a reason code above); null otherwise. */
  reason: string | null;
}

/**
 * Whether the coin is in the list: YES when a pair carries its CMC id; NO only when a verified list
 * has none and no unattributed pair shares its ticker; otherwise UNKNOWN. The ticker is used only
 * to withhold a NO, never to claim a listing.
 */
export function availability(view: ListView, cmcId: number, symbol: string): Availability {
  if (view.status !== 'VERIFIED')
    return { status: 'UNKNOWN', pairs: [], reason: UNKNOWN_REASON[view.status] };
  const pairs = view.listed.get(cmcId);
  if (pairs?.length) return { status: 'YES', pairs, reason: null };
  if (view.unmappedTickers.has(symbol.toUpperCase()))
    return { status: 'UNKNOWN', pairs: [], reason: UNKNOWN_REASON.unmappedPair };
  return { status: 'NO', pairs: [], reason: null };
}

/** Spot / Futures filter of the event list (LBank): exact combinations, or one market regardless of the other. */
export const MARKET_FILTERS = [
  'both',
  'spot_only',
  'futures_only',
  'spot',
  'futures',
  'neither',
  'unknown',
] as const;
export type MarketFilter = (typeof MARKET_FILTERS)[number];

export const BITHUMB_FILTERS = ['listed', 'not_listed', 'unknown'] as const;
export type BithumbFilter = (typeof BITHUMB_FILTERS)[number];

/** Which Spot / Futures answers a market filter keeps; `marketFilterSql` selects the same rows. */
export function matchesMarket(filter: MarketFilter, spot: Listed, futures: Listed): boolean {
  switch (filter) {
    case 'both':
      return spot === 'YES' && futures === 'YES';
    case 'spot_only':
      return spot === 'YES' && futures === 'NO';
    case 'futures_only':
      return spot === 'NO' && futures === 'YES';
    case 'spot':
      return spot === 'YES';
    case 'futures':
      return futures === 'YES';
    case 'neither':
      return spot === 'NO' && futures === 'NO';
    case 'unknown':
      return spot === 'UNKNOWN' || futures === 'UNKNOWN';
  }
}

export function matchesBithumb(filter: BithumbFilter, listed: Listed): boolean {
  return listed === bithumbWant(filter);
}

const bithumbWant = (filter: BithumbFilter): Listed =>
  filter === 'listed' ? 'YES' : filter === 'not_listed' ? 'NO' : 'UNKNOWN';

export interface SqlCondition {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * SQL over an event row (`<alias>.cmc_id`, `<alias>.symbol`) that holds exactly when
 * `availability(view, cmc_id, symbol).status` is `want`. `name` keeps parameter names apart.
 */
export function availabilitySql(
  view: ListView,
  want: Listed,
  name: string,
  alias = 'e',
): SqlCondition {
  if (view.status !== 'VERIFIED') return { sql: want === 'UNKNOWN' ? 'TRUE' : 'FALSE', params: {} };
  const ids = `${name}Ids`;
  const tickers = `${name}Tickers`;
  const params = { [ids]: [...view.listed.keys()], [tickers]: [...view.unmappedTickers] };
  const listed = `(${alias}.cmc_id = ANY(CAST(:${ids} AS integer[])))`;
  const unmapped = `(UPPER(${alias}.symbol) = ANY(CAST(:${tickers} AS text[])))`;
  if (want === 'YES') return { sql: listed, params };
  if (want === 'UNKNOWN') return { sql: `(NOT ${listed} AND ${unmapped})`, params };
  return { sql: `(NOT ${listed} AND NOT ${unmapped})`, params };
}

const join = (op: 'AND' | 'OR', parts: SqlCondition[]): SqlCondition => ({
  sql: `(${parts.map((p) => p.sql).join(` ${op} `)})`,
  params: Object.assign({}, ...parts.map((p) => p.params)) as Record<string, unknown>,
});

export function marketFilterSql(
  filter: MarketFilter,
  spot: ListView,
  futures: ListView,
): SqlCondition {
  const s = (want: Listed) => availabilitySql(spot, want, `marketSpot${want}`);
  const f = (want: Listed) => availabilitySql(futures, want, `marketFutures${want}`);
  switch (filter) {
    case 'both':
      return join('AND', [s('YES'), f('YES')]);
    case 'spot_only':
      return join('AND', [s('YES'), f('NO')]);
    case 'futures_only':
      return join('AND', [s('NO'), f('YES')]);
    case 'spot':
      return s('YES');
    case 'futures':
      return f('YES');
    case 'neither':
      return join('AND', [s('NO'), f('NO')]);
    case 'unknown':
      return join('OR', [s('UNKNOWN'), f('UNKNOWN')]);
  }
}

export function bithumbFilterSql(filter: BithumbFilter, view: ListView): SqlCondition {
  return availabilitySql(view, bithumbWant(filter), 'bithumb');
}

/**
 * Whether a list is due for a fetch: FRESH while the latest complete list is younger than the
 * refresh period; RETRY_LATER while a later failed or incomplete attempt is younger than the retry
 * interval; DUE otherwise.
 */
export function refreshDue(
  complete: { finishedAt: Date } | null,
  attempt: { finishedAt: Date; status: string } | null,
  now: Date,
  refreshMs: number,
  retryMs = Math.min(refreshMs, LIST_RETRY_MS),
): 'DUE' | 'FRESH' | 'RETRY_LATER' {
  if (complete && now.getTime() - complete.finishedAt.getTime() < refreshMs) return 'FRESH';
  if (
    attempt &&
    attempt.status !== 'COMPLETE' &&
    now.getTime() - attempt.finishedAt.getTime() < retryMs
  )
    return 'RETRY_LATER';
  return 'DUE';
}

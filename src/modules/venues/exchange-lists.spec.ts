import { describe, expect, it } from 'vitest';

import type { VenuePair } from '../strategy/index.js';

import {
  EXCHANGE_LISTS,
  LIST_RETRY_MS,
  type Listed,
  MARKET_FILTERS,
  type StoredList,
  availability,
  availabilitySql,
  bithumbFilterSql,
  listView,
  marketFilterSql,
  matchesBithumb,
  matchesMarket,
  refreshDue,
} from './exchange-lists.js';

/** Synthetic pairs and crawls (ids ≥ 990001 are fixture-style; nothing here is market data). */
const NOW = new Date('2026-11-17T12:00:00.000Z');
const HOUR = 3_600_000;
const MAX_AGE = 72 * HOUR;

function pair(
  exchange: string,
  category: string,
  base: string,
  cmcId: number | null,
  quote = 'USDT',
): VenuePair {
  return {
    exchange,
    exchangeName: exchange,
    marketPair: `${base}/${quote}`,
    category,
    baseSymbol: base,
    baseCurrencyId: cmcId,
    quoteSymbol: quote,
    quoteCurrencyId: 825,
    volumeUsd: '1000',
    volumePercent: null,
    priceUsd: null,
    lastUpdated: null,
    marketUrl: null,
    tradingStatus: null,
    type: 'cex',
    flags: [],
  };
}

const crawl = (
  status: StoredList['status'],
  finishedAt: Date,
  pairs: VenuePair[] = [],
  id = `c-${status}-${finishedAt.getTime()}`,
) => ({ id, status, finishedAt, fetchedCount: pairs.length, error: null, pairs });

const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

describe('exchange listings by CMC id (ADR-0007)', () => {
  const futuresPairs = [
    pair('lbank', 'perpetual', 'BTC', 990001),
    // Multiplier tickers are common in perpetuals: still this CMC id, never matched by ticker.
    pair('lbank', 'perpetual', '1000PEPX', 990002),
    // The same crawl may carry rows of other categories or exchanges: they never count here.
    pair('lbank', 'spot', 'SPOT', 990003),
    pair('bithumb', 'perpetual', 'ELSE', 990004),
  ];
  const fresh = crawl('COMPLETE', ago(2), futuresPairs);
  const view = listView(EXCHANGE_LISTS.lbankFutures, fresh, fresh, NOW, MAX_AGE, true);

  it('a verified list says YES by CMC id with its pairs, whatever the ticker, and NO otherwise', () => {
    expect(view.status).toBe('VERIFIED');
    expect(availability(view, 990001, 'BTCF')).toEqual({
      status: 'YES',
      pairs: ['BTC/USDT'],
      reason: null,
    });
    expect(availability(view, 990002, 'PEPX').status).toBe('YES');
    // A Spot row stored in the same crawl says nothing about Futures; neither does another exchange.
    expect(availability(view, 990003, 'SPOT').status).toBe('NO');
    expect(availability(view, 990004, 'ELSE').status).toBe('NO');
    // A coin that only shares a listed ticker with another CMC id is not listed.
    expect(availability(view, 990099, 'BTC').status).toBe('NO');
  });

  it('a pair without a CMC id that carries the coin ticker makes it UNKNOWN, never YES or NO', () => {
    const c = crawl('COMPLETE', ago(1), [
      pair('bithumb', 'spot', 'TWIN', null, 'KRW'),
      pair('bithumb', 'spot', 'GAPD', 990007, 'KRW'),
    ]);
    const v = listView(EXCHANGE_LISTS.bithumb, c, c, NOW, MAX_AGE, true);
    expect(availability(v, 990005, 'twin')).toEqual({
      status: 'UNKNOWN',
      pairs: [],
      reason: 'UNMAPPED_PAIR_SAME_TICKER',
    });
    expect(availability(v, 990007, 'GAPD').status).toBe('YES');
    expect(availability(v, 990008, 'OTHER').status).toBe('NO');
  });

  it('an unverified list never says NO: not fetched, failed, incomplete, stale, unsupported', () => {
    const spec = EXCHANGE_LISTS.bithumb;
    const state = (v: ReturnType<typeof listView>) => [v.status, availability(v, 990001, 'X')];
    expect(state(listView(spec, null, null, NOW, MAX_AGE, true))).toEqual([
      'NOT_FETCHED',
      { status: 'UNKNOWN', pairs: [], reason: 'LIST_NOT_FETCHED' },
    ]);
    expect(state(listView(spec, null, crawl('FAILED', ago(1)), NOW, MAX_AGE, true))[1]).toEqual({
      status: 'UNKNOWN',
      pairs: [],
      reason: 'LIST_FAILED',
    });
    const partial = crawl('INCOMPLETE', ago(1), [pair('bithumb', 'spot', 'X', 990001, 'KRW')]);
    // Even a pair present in an incomplete list is not taken as proof either way.
    expect(state(listView(spec, null, partial, NOW, MAX_AGE, true))).toEqual([
      'INCOMPLETE',
      { status: 'UNKNOWN', pairs: [], reason: 'LIST_INCOMPLETE' },
    ]);
    expect(state(listView(spec, fresh, fresh, NOW, MAX_AGE, false))[0]).toBe('UNSUPPORTED');
  });

  it('a list counts until exactly its maximum age, then is stale', () => {
    const spec = EXCHANGE_LISTS.lbankFutures;
    const edge = crawl('COMPLETE', new Date(NOW.getTime() - MAX_AGE), futuresPairs);
    expect(listView(spec, edge, edge, NOW, MAX_AGE, true).status).toBe('VERIFIED');
    const old = crawl('COMPLETE', new Date(NOW.getTime() - MAX_AGE - 1), futuresPairs);
    const v = listView(spec, old, old, NOW, MAX_AGE, true);
    expect([v.status, v.listed.size, availability(v, 990001, 'BTC').reason]).toEqual([
      'STALE',
      0,
      'LIST_STALE',
    ]);
    expect(v.staleAt).toEqual(new Date(NOW.getTime() - 1));
  });

  it('a later failed attempt keeps a fresh complete list in use and is reported', () => {
    const failed = { ...crawl('FAILED', ago(1)), error: 'HTTP 503 (synthetic)' };
    const v = listView(EXCHANGE_LISTS.lbankFutures, fresh, failed, NOW, MAX_AGE, true);
    expect(v.status).toBe('VERIFIED');
    expect(v.crawlId).toBe(fresh.id);
    expect(v.lastAttempt).toEqual({
      at: failed.finishedAt,
      status: 'FAILED',
      error: 'HTTP 503 (synthetic)',
    });
    expect(availability(v, 990001, 'BTC').status).toBe('YES');
  });
});

describe('Spot / Futures and Bithumb filters', () => {
  const all: Listed[] = ['YES', 'NO', 'UNKNOWN'];
  const kept = (f: (typeof MARKET_FILTERS)[number]) =>
    all.flatMap((s) => all.filter((x) => matchesMarket(f, s, x)).map((x) => `${s}/${x}`));

  it('keeps exactly the intended Spot / Futures combinations; Unknown is never taken as No', () => {
    expect(kept('both')).toEqual(['YES/YES']);
    expect(kept('spot_only')).toEqual(['YES/NO']);
    expect(kept('futures_only')).toEqual(['NO/YES']);
    expect(kept('spot')).toEqual(['YES/YES', 'YES/NO', 'YES/UNKNOWN']);
    expect(kept('futures')).toEqual(['YES/YES', 'NO/YES', 'UNKNOWN/YES']);
    expect(kept('neither')).toEqual(['NO/NO']);
    expect(kept('unknown')).toEqual([
      'YES/UNKNOWN',
      'NO/UNKNOWN',
      'UNKNOWN/YES',
      'UNKNOWN/NO',
      'UNKNOWN/UNKNOWN',
    ]);
    expect(all.filter((b) => matchesBithumb('listed', b))).toEqual(['YES']);
    expect(all.filter((b) => matchesBithumb('not_listed', b))).toEqual(['NO']);
    expect(all.filter((b) => matchesBithumb('unknown', b))).toEqual(['UNKNOWN']);
  });

  it('builds SQL from the same rule: an unverified list selects only UNKNOWN', () => {
    const none = listView(EXCHANGE_LISTS.bithumb, null, null, NOW, MAX_AGE, true);
    expect(availabilitySql(none, 'YES', 'x').sql).toBe('FALSE');
    expect(availabilitySql(none, 'NO', 'x').sql).toBe('FALSE');
    expect(availabilitySql(none, 'UNKNOWN', 'x').sql).toBe('TRUE');
    expect(bithumbFilterSql('unknown', none).sql).toBe('TRUE');

    const c = crawl('COMPLETE', ago(1), [
      pair('bithumb', 'spot', 'AAA', 990001, 'KRW'),
      pair('bithumb', 'spot', 'ZZZ', null, 'KRW'),
    ]);
    const v = listView(EXCHANGE_LISTS.bithumb, c, c, NOW, MAX_AGE, true);
    expect(bithumbFilterSql('listed', v)).toEqual({
      sql: '(e.cmc_id = ANY(CAST(:bithumbIds AS integer[])))',
      params: { bithumbIds: [990001], bithumbTickers: ['ZZZ'] },
    });
    // Two conditions in one filter never share parameter names.
    const both = marketFilterSql('spot_only', v, v);
    expect(Object.keys(both.params).sort()).toEqual([
      'marketFuturesNOIds',
      'marketFuturesNOTickers',
      'marketSpotYESIds',
      'marketSpotYESTickers',
    ]);
    expect(both.sql).toMatch(/^\(.* AND .*\)$/);
  });
});

describe('list refresh schedule', () => {
  const REFRESH = 24 * HOUR;
  it('reuses a list younger than the refresh period and fetches it again from then on', () => {
    expect(refreshDue({ finishedAt: ago(23.99) }, null, NOW, REFRESH)).toBe('FRESH');
    expect(refreshDue({ finishedAt: ago(24) }, null, NOW, REFRESH)).toBe('DUE');
    expect(refreshDue(null, null, NOW, REFRESH)).toBe('DUE');
  });

  it('retries a failed or incomplete attempt after the retry interval, not every hour', () => {
    const failed = { finishedAt: ago(1), status: 'FAILED' };
    expect(refreshDue(null, failed, NOW, REFRESH)).toBe('RETRY_LATER');
    expect(refreshDue({ finishedAt: ago(30) }, failed, NOW, REFRESH)).toBe('RETRY_LATER');
    expect(
      refreshDue(
        null,
        { finishedAt: ago(LIST_RETRY_MS / HOUR), status: 'INCOMPLETE' },
        NOW,
        REFRESH,
      ),
    ).toBe('DUE');
    // The retry interval never exceeds a shorter refresh period.
    expect(refreshDue(null, { finishedAt: ago(2), status: 'FAILED' }, NOW, 2 * HOUR)).toBe('DUE');
  });
});

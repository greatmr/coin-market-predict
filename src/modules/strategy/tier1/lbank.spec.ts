import { describe, expect, it } from 'vitest';

import {
  type VenueDecisionView,
  type VenuePair,
  buildLbankContext,
  resolveLbank,
} from './lbank.js';

const AS_OF = new Date('2026-11-05T07:07:00Z');
const MAX = 120 * 60_000;
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
const crawl = (
  pairs: VenuePair[],
  status: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' = 'COMPLETE',
  finishedAt = new Date(AS_OF.getTime() + 5_000),
) => ({ id: 'c1', status, finishedAt, pairs });
const noHistory = { lastAbsentAt: new Map<string, Date>(), everListed: new Set<string>() };
const decision = (
  marketPair: string | null,
  kind: VenueDecisionView['decision'],
  at: Date,
): VenueDecisionView => ({
  id: `${kind}-${marketPair}`,
  marketPair,
  decision: kind,
  decidedAt: at,
  reviewer: 't',
  source: 'review',
});

describe('LBank pair status (p.9, p.10)', () => {
  it('feed without trading status → PAIR_LISTED_UNVERIFIED; feed proof → VERIFIED; all quote currencies kept', () => {
    const ctx = buildLbankContext(crawl([pair('ABC', 7), pair('ABC', 7, 'BTC')]), AS_OF, MAX);
    const r = resolveLbank(7, 'ABC', ctx, [], noHistory);
    expect([r.status, r.reason]).toEqual(['PAIR_LISTED_UNVERIFIED', 'NO_TRADING_STATUS_PROOF']);
    expect(r.pairs.map((p) => p.marketPair)).toEqual(['ABC/USDT', 'ABC/BTC']);
    const proven = resolveLbank(
      7,
      'ABC',
      buildLbankContext(crawl([pair('ABC', 7, 'USDT', 'TRADING')]), AS_OF, MAX),
      [],
      noHistory,
    );
    expect(proven.status).toBe('VERIFIED');
  });

  it('missing, incomplete, failed or stale crawls → UNKNOWN, never silently eligible', () => {
    expect(resolveLbank(7, 'ABC', buildLbankContext(null, AS_OF, MAX), [], noHistory).reason).toBe(
      'LBANK_FEED_MISSING',
    );
    expect(
      resolveLbank(
        7,
        'ABC',
        buildLbankContext(crawl([pair('ABC', 7)], 'INCOMPLETE'), AS_OF, MAX),
        [],
        noHistory,
      ).reason,
    ).toBe('LBANK_FEED_INCOMPLETE');
    expect(
      resolveLbank(
        7,
        'ABC',
        buildLbankContext(crawl([pair('ABC', 7)], 'FAILED'), AS_OF, MAX),
        [],
        noHistory,
      ).reason,
    ).toBe('LBANK_FEED_FAILED');
    const old = crawl([pair('ABC', 7)], 'COMPLETE', new Date(AS_OF.getTime() - MAX - 1));
    expect(resolveLbank(7, 'ABC', buildLbankContext(old, AS_OF, MAX), [], noHistory)).toMatchObject(
      { status: 'UNKNOWN', reason: 'LBANK_FEED_STALE' },
    );
  });

  it('an ambiguous base ticker is never guessed: UNKNOWN plus a mapping-evidence task until a reviewer decides', () => {
    const ctx = buildLbankContext(
      crawl([pair('ABCX', 7, 'USDT', 'TRADING'), pair('DUP', 8), pair('DUP', 9, 'BTC')]),
      AS_OF,
      MAX,
    );
    const mismatch = resolveLbank(7, 'ABC', ctx, [], noHistory);
    expect([mismatch.status, mismatch.reason]).toEqual(['UNKNOWN', 'AMBIGUOUS_MAPPING']);
    expect(mismatch.tasks.map((t) => t.kind)).toEqual(['SYMBOL_MISMATCH']);
    expect(resolveLbank(8, 'DUP', ctx, [], noHistory).tasks.map((t) => t.kind)).toEqual([
      'TICKER_MULTIPLE_IDS',
    ]);
    const confirmed = resolveLbank(
      7,
      'ABC',
      ctx,
      [decision('ABCX/USDT', 'MAPPING_CONFIRMED', AS_OF)],
      noHistory,
    );
    expect([confirmed.status, confirmed.tasks.length]).toEqual(['VERIFIED', 0]);
    const rejected = resolveLbank(
      7,
      'ABC',
      ctx,
      [decision('ABCX/USDT', 'MAPPING_REJECTED', AS_OF)],
      noHistory,
    );
    expect(rejected.status).toBe('NOT_LISTED');
  });

  it('a reviewer verification counts until the pair disappears; a disappeared pair is UNKNOWN until reverified (A9)', () => {
    const ctx = buildLbankContext(crawl([pair('ABC', 7)]), AS_OF, MAX);
    const verifiedAt = new Date('2026-11-01T00:00:00Z');
    expect(
      resolveLbank(
        7,
        'ABC',
        ctx,
        [decision('ABC/USDT', 'VERIFIED_TRADABLE', verifiedAt)],
        noHistory,
      ).status,
    ).toBe('VERIFIED');
    const absentLater = {
      lastAbsentAt: new Map([['ABC/USDT', new Date('2026-11-02T00:00:00Z')]]),
      everListed: new Set(['ABC/USDT']),
    };
    const voided = resolveLbank(
      7,
      'ABC',
      ctx,
      [decision('ABC/USDT', 'VERIFIED_TRADABLE', verifiedAt)],
      absentLater,
    );
    expect(voided.status).toBe('PAIR_LISTED_UNVERIFIED');
    expect(voided.pairs[0]!.evidence.join(' ')).toMatch(/voided/);
    const gone = resolveLbank(7, 'ABC', buildLbankContext(crawl([]), AS_OF, MAX), [], {
      lastAbsentAt: new Map(),
      everListed: new Set(['ABC/USDT']),
    });
    expect([gone.status, gone.reason]).toEqual(['UNKNOWN', 'PAIR_DISAPPEARED']);
    const confirmedGone = resolveLbank(
      7,
      'ABC',
      buildLbankContext(crawl([]), AS_OF, MAX),
      [decision(null, 'NOT_TRADABLE', AS_OF)],
      { lastAbsentAt: new Map(), everListed: new Set(['ABC/USDT']) },
    );
    expect(confirmedGone.status).toBe('NOT_TRADABLE');
    expect(
      resolveLbank(7, 'ABC', buildLbankContext(crawl([]), AS_OF, MAX), [], noHistory).status,
    ).toBe('NOT_LISTED');
  });

  it("a reviewer's NOT_TRADABLE wins over feed proof", () => {
    const ctx = buildLbankContext(crawl([pair('ABC', 7, 'USDT', 'TRADING')]), AS_OF, MAX);
    expect(
      resolveLbank(7, 'ABC', ctx, [decision('ABC/USDT', 'NOT_TRADABLE', AS_OF)], noHistory).status,
    ).toBe('NOT_TRADABLE');
  });
});

describe('LBank Spot markets list as the source (operator decisions D1, D2)', () => {
  const DAYS_35 = 35 * 86_400_000;
  const listed = (pairs: VenuePair[], finishedAt = new Date(AS_OF.getTime() - 20 * 86_400_000)) =>
    buildLbankContext(crawl(pairs, 'COMPLETE', finishedAt), AS_OF, DAYS_35, {
      listingIsTradable: true,
    });

  it('a listed, unambiguous pair counts as tradable without a separate check; the evidence says so', () => {
    const r = resolveLbank(7, 'ABC', listed([pair('ABC', 7)]), [], noHistory);
    expect([r.status, r.pairs[0]!.trading, r.pairs[0]!.tradingSource]).toEqual([
      'VERIFIED',
      'TRADING',
      'listing',
    ]);
    expect(r.pairs[0]!.evidence.join(' ')).toMatch(/listed in CMC's LBank Spot markets/);
  });

  it("a reviewer's NOT_TRADABLE still wins, ambiguous tickers still need a decision, unlisted coins stay NOT_LISTED", () => {
    expect(
      resolveLbank(
        7,
        'ABC',
        listed([pair('ABC', 7)]),
        [decision('ABC/USDT', 'NOT_TRADABLE', AS_OF)],
        noHistory,
      ).status,
    ).toBe('NOT_TRADABLE');
    const amb = resolveLbank(7, 'ABC', listed([pair('ABCX', 7)]), [], noHistory);
    expect([amb.status, amb.reason, amb.tasks.length]).toEqual(['UNKNOWN', 'AMBIGUOUS_MAPPING', 1]);
    expect(resolveLbank(8, 'XYZ', listed([pair('ABC', 7)]), [], noHistory).status).toBe(
      'NOT_LISTED',
    );
  });

  it('a monthly list stays usable for the configured max age, then becomes stale (UNKNOWN)', () => {
    expect(
      resolveLbank(
        7,
        'ABC',
        listed([pair('ABC', 7)], new Date(AS_OF.getTime() - DAYS_35 + 60_000)),
        [],
        noHistory,
      ).status,
    ).toBe('VERIFIED');
    expect(
      resolveLbank(
        7,
        'ABC',
        listed([pair('ABC', 7)], new Date(AS_OF.getTime() - DAYS_35 - 60_000)),
        [],
        noHistory,
      ),
    ).toMatchObject({ status: 'UNKNOWN', reason: 'LBANK_FEED_STALE' });
  });
});

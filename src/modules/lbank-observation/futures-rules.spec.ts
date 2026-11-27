import { describe, expect, it } from 'vitest';

import { D } from '../../common/utils/decimal.js';

import {
  type FuturesMapping,
  type FuturesSample,
  emptyFold,
  evaluateFutures,
  foldFutures,
  mapFuturesContract,
} from './futures-rules.js';

const T = Date.parse('2026-11-27T10:07:05.400Z');
const W = { startMs: T, endMs: T + 168 * 3_600_000 };
const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
const s = (offsetMs: number, price: string, turnover: string): FuturesSample => ({
  serverMs: sec(T + offsetMs),
  fetchedMs: sec(T + offsetMs) + 300,
  lastPrice: new D(price),
  turnover: new D(turnover),
});
const ok: FuturesMapping = { status: 'OK', contract: 'BIGTIMEUSDT', reasons: [], evidence: {} };
const evalAt = (
  nowMs: number,
  fold = emptyFold(),
  extra: Partial<Parameters<typeof evaluateFutures>[0]> = {},
) =>
  evaluateFutures({
    nowMs,
    mapping: ok,
    window: W,
    fold,
    lastPollServerMs: null,
    contractInLastPoll: true,
    cmcPriceUsd: null,
    ...extra,
  });

describe('mapFuturesContract', () => {
  const ev = (cmc: unknown, lbank: unknown) => ({ cmcFutures: cmc, lbankFutures: lbank });
  const lb = (rows: Array<[string, string]>) => ({
    fetchedAt: '2026-11-27T10:15:00Z',
    contracts: rows.map(([symbol, base]) => ({ symbol, base, quote: 'USDT' })),
  });
  it('maps the one URL-pinned CMC contract that LBank lists (BIGTIME)', () => {
    const m = mapFuturesContract({
      evidence: ev({ status: 'YES', contracts: ['BIGTIMEUSDT'] }, lb([['BIGTIMEUSDT', 'BIGTIME']])),
      coinSymbol: 'BIGTIME',
    });
    expect(m).toMatchObject({ status: 'OK', contract: 'BIGTIMEUSDT', reasons: [] });
  });
  it('never maps by ticker alone (CMC attributes DYDXUSDT / MONUSDT to other assets)', () => {
    const m = mapFuturesContract({
      evidence: ev({ status: 'NO', contracts: [] }, lb([['DYDXUSDT', 'DYDX']])),
      coinSymbol: 'DYDX',
    });
    expect(m).toMatchObject({
      status: 'AMBIGUOUS',
      contract: null,
      reasons: ['FUTURES_TICKER_ONLY'],
    });
  });
  it('no contract on either list → NONE', () => {
    expect(
      mapFuturesContract({ evidence: ev({ status: 'NO', contracts: [] }, lb([])), coinSymbol: 'X' })
        .status,
    ).toBe('NONE');
  });
  it('several contracts, or one LBank does not list → AMBIGUOUS', () => {
    expect(
      mapFuturesContract({
        evidence: ev({ status: 'YES', contracts: ['AUSDT', 'A1000USDT'] }, lb([['AUSDT', 'A']])),
        coinSymbol: 'A',
      }).reasons,
    ).toEqual(['MULTIPLE_FUTURES_CONTRACTS']);
    expect(
      mapFuturesContract({
        evidence: ev({ status: 'YES', contracts: ['AUSDT'] }, lb([])),
        coinSymbol: 'A',
      }).reasons,
    ).toEqual(['FUTURES_NOT_IN_LBANK_LIST']);
  });
  it('missing list evidence → UNKNOWN; no evidence yet → PENDING', () => {
    expect(
      mapFuturesContract({
        evidence: ev({ status: 'YES', contracts: ['AUSDT'] }, { notFetched: 'x' }),
        coinSymbol: 'A',
      }).status,
    ).toBe('UNKNOWN');
    expect(mapFuturesContract({ evidence: null, coinSymbol: 'A' }).status).toBe('PENDING');
  });
});

describe('foldFutures / evaluateFutures', () => {
  it('a snapshot after the start is not a trade after the start without a bracket', () => {
    // Anchor before the start; the next snapshot's turnover rose, but its bracket starts before T.
    const f = foldFutures(emptyFold(), [s(-30_000, '1.00', '100'), s(30_000, '1.10', '150')], W);
    expect(f.anchorMs).toBe(sec(T - 30_000));
    expect(f.reference).toBeNull();
    expect(evalAt(T + 60_000, f)).toMatchObject({
      status: 'ACTIVE',
      reasons: ['WINDOW_OPEN', 'FUTURES_REFERENCE_PENDING'],
    });
  });

  it('reference = the first bracket wholly after the start; unchanged turnover is no trade', () => {
    const f = foldFutures(
      emptyFold(),
      [
        s(-30_000, '1.00', '100'),
        s(30_000, '1.10', '150'), // bracket starts before T: not eligible
        s(90_000, '1.20', '150'), // turnover unchanged: no proven trade (price may be stale)
        s(150_000, '1.05', '170'), // eligible: trade in (T+90 s, T+151 s)
        s(210_000, '1.50', '200'),
        s(270_000, '0.90', '260'),
      ],
      W,
    );
    expect(f.reference).toEqual({
      price: '1.05',
      afterMs: sec(T + 90_000),
      beforeMs: sec(T + 150_000) + 1000,
      sampleMs: sec(T + 150_000),
    });
    expect(f.highest?.price).toBe('1.5');
    expect(f.lowest?.price).toBe('0.9');
    expect(f.bracketedInWindow).toBe(3);
    const e = evalAt(T + 300_000, f);
    expect(e.status).toBe('ACTIVE');
    expect(e.highestReturnPct?.toFixed()).toBe(
      new D('1.5').div('1.05').minus(1).times(100).toFixed(),
    );
    expect(e.lowestReturnPct?.lt(0)).toBe(true);
  });

  it('sampling that began after the start → HISTORY_UNAVAILABLE (never filled from Spot)', () => {
    const f = foldFutures(emptyFold(), [s(3_600_000, '1', '1'), s(3_660_000, '2', '2')], W);
    expect(f.unsampledStart).toBe(true);
    expect(f.reference).toBeNull();
    expect(evalAt(T + 3_700_000, f)).toMatchObject({
      status: 'HISTORY_UNAVAILABLE',
      terminal: true,
      highestReturnPct: null,
    });
  });

  it('a bracket crossing the end is not in the window; a snapshot at the end closes it', () => {
    const end = W.endMs;
    const f = foldFutures(
      emptyFold(),
      [
        s(-1_000, '1', '10'),
        s(60_000, '1', '10'),
        s(120_000, '2', '20'),
        // Stamped …:04 (end is …:05.400): its second ends at …:05.000, inside the window.
        {
          serverMs: sec(end - 1_000),
          fetchedMs: end,
          lastPrice: new D('3'),
          turnover: new D('25'),
        },
        // Stamped …:05, the end's own second: the snapshot may be after the end → excluded.
        { serverMs: sec(end), fetchedMs: end + 600, lastPrice: new D('9'), turnover: new D('30') },
        {
          serverMs: sec(end + 30_000),
          fetchedMs: end + 30_000,
          lastPrice: new D('0.1'),
          turnover: new D('40'),
        },
      ],
      W,
    );
    expect(f.highest?.price).toBe('3');
    expect(f.lowest?.price).toBe('2');
    expect(evalAt(end + 60_000, f)).toMatchObject({ status: 'CLOSED', terminal: true });
  });

  it('folding in pieces equals folding at once', () => {
    const all = [
      s(-5_000, '1', '1'),
      s(55_000, '1.2', '2'),
      s(115_000, '1.1', '3'),
      s(175_000, '1.4', '3'),
      s(235_000, '0.8', '9'),
    ];
    const once = foldFutures(emptyFold(), all, W);
    const twice = foldFutures(foldFutures(emptyFold(), all.slice(0, 2), W), all.slice(2), W);
    expect(twice).toEqual(once);
  });

  it('mapping and timing states never produce numbers', () => {
    for (const [status, want] of [
      ['NONE', 'NO_CONTRACT'],
      ['AMBIGUOUS', 'MAPPING_AMBIGUOUS'],
      ['UNKNOWN', 'MAPPING_UNKNOWN'],
      ['PENDING', 'PENDING'],
    ] as const)
      expect(
        evalAt(T, emptyFold(), { mapping: { ...ok, status, contract: null, reasons: ['r'] } }),
      ).toMatchObject({ status: want, highestReturnPct: null });
    expect(evalAt(T, emptyFold(), { window: null }).status).toBe('PENDING');
  });

  it('flags a reference far from the CMC price (identity check, not exclusion)', () => {
    const f = foldFutures(
      emptyFold(),
      [s(-1_000, '1', '1'), s(59_000, '1', '1'), s(119_000, '2', '2')],
      W,
    );
    expect(evalAt(T + 200_000, f, { cmcPriceUsd: new D('1') }).flags).toEqual([
      'FUTURES_PRICE_DEVIATION_FROM_CMC',
    ]);
  });

  it('a contract missing from marketData after the end closes without a reference', () => {
    const f = foldFutures(emptyFold(), [s(-1_000, '1', '1')], W);
    expect(
      evalAt(W.endMs + 60_000, f, { lastPollServerMs: W.endMs + 1_000, contractInLastPoll: false }),
    ).toMatchObject({
      status: 'NO_REFERENCE',
      reasons: ['CONTRACT_MISSING_FROM_MARKET_DATA', 'NO_BRACKETED_FUTURES_TRADE'],
    });
  });
});

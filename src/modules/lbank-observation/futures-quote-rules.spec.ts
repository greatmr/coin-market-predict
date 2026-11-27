import { describe, expect, it } from 'vitest';

import { D } from '../../common/utils/decimal.js';

import {
  type QuoteObservation,
  earliestEligible,
  evaluateQuote,
  isEligible,
  mapAtPublication,
  replacesReference,
  windowValues,
} from './futures-quote-rules.js';
import type { FuturesMapping } from './futures-rules.js';

const S = Date.parse('2026-11-27T09:07:06.766Z');
const W = { startMs: S, endMs: S + 168 * 3_600_000 };
let id = 0;
const obs = (
  sentOffset: number | null,
  recvOffset: number,
  price: string | null,
  source: QuoteObservation['source'] = 'PUBLICATION',
): QuoteObservation => ({
  pollId: String(++id),
  source,
  requestStartedMs: sentOffset === null ? null : S + sentOffset,
  responseMs: S + recvOffset,
  price: price === null ? null : new D(price),
});
const ok: FuturesMapping = { status: 'OK', contract: 'CFGUSDT', reasons: [], evidence: {} };

describe('eligibility', () => {
  it('a request sent before the start is never eligible, even if answered after it', () => {
    expect(isEligible(obs(-1, 400, '1'), W)).toBe(false);
    expect(isEligible(obs(0, 400, '1'), W)).toBe(true); // sent exactly at the start
  });
  it('a response at the exact end is outside [start, end)', () => {
    expect(isEligible(obs(W.endMs - S - 500, W.endMs - S, '1'), W)).toBe(false);
    expect(isEligible(obs(W.endMs - S - 500, W.endMs - S - 1, '1'), W)).toBe(true);
  });
  it('no recorded send time (before the fix), missing or invalid price: not eligible', () => {
    expect(isEligible(obs(null, 400, '1'), W)).toBe(false);
    expect(isEligible(obs(10, 400, null), W)).toBe(false);
    expect(isEligible(obs(10, 400, '0'), W)).toBe(false);
  });
});

describe('earliest eligible reference', () => {
  it('is the first response received, whatever the processing order', () => {
    const late = obs(1_000, 2_000, '1.2', 'RETRY');
    const first = obs(5, 845, '1.1');
    const pre = obs(-200, 300, '9'); // sent before the start
    expect(earliestEligible([late, pre, first], W)?.pollId).toBe(first.pollId);
    expect(earliestEligible([first, late, pre], W)?.pollId).toBe(first.pollId);
    expect(replacesReference(first, late)).toBe(false);
    expect(replacesReference(late, first)).toBe(true);
  });
  it('ignores 24 h turnover and an unchanged price: the first valid quote qualifies', () => {
    // The rules take no turnover input at all; the same price twice still picks the first receipt.
    const a = obs(5, 800, '0.137');
    const b = obs(60_000, 60_400, '0.137', 'TICK');
    expect(earliestEligible([b, a], W)?.pollId).toBe(a.pollId);
  });
  it('a failed first response leaves the first valid later one (real delay kept)', () => {
    const failed = obs(5, 30_000, null);
    const retry = obs(32_000, 32_500, '1.05', 'RETRY');
    const r = earliestEligible([failed, retry], W)!;
    expect(r.pollId).toBe(retry.pollId);
    expect(r.responseMs - S).toBe(32_500);
  });
});

describe('mapping at publication', () => {
  const sym = new Set(['CFGUSDT', 'DYDXUSDT']);
  it('maps the one URL-pinned CMC contract present in the eligible response', () => {
    expect(
      mapAtPublication({
        cmc: { status: 'YES', contracts: ['CFGUSDT'], fetchedAt: null },
        lbankSymbols: sym,
        lbankPollId: '7',
        coinSymbol: 'CFG',
      }),
    ).toMatchObject({ status: 'OK', contract: 'CFGUSDT' });
  });
  it('waits for an eligible response instead of guessing', () => {
    expect(
      mapAtPublication({
        cmc: { status: 'YES', contracts: ['CFGUSDT'], fetchedAt: null },
        lbankSymbols: null,
        lbankPollId: null,
        coinSymbol: 'CFG',
      }).status,
    ).toBe('PENDING');
  });
  it('ticker-only, several contracts, unknown list, nothing', () => {
    const m = (contracts: string[], status = 'NO', coin = 'DYDX') =>
      mapAtPublication({
        cmc: { status, contracts, fetchedAt: null },
        lbankSymbols: sym,
        lbankPollId: '7',
        coinSymbol: coin,
      });
    expect(m([]).status).toBe('AMBIGUOUS');
    expect(m(['AUSDT', 'BUSDT'], 'YES').status).toBe('AMBIGUOUS');
    // The one CMC contract missing from this response: decided again later, never guessed.
    expect(m(['QQQUSDT'], 'YES')).toMatchObject({
      status: 'PENDING',
      reasons: ['FUTURES_NOT_IN_LBANK_LIST'],
    });
    expect(m([], 'UNKNOWN').status).toBe('UNKNOWN');
    expect(m([], 'NO', 'ZZZ').status).toBe('NONE');
  });
});

describe('window values and status', () => {
  it('observed extremes include the reference and stay inside [start, end)', () => {
    const ref = obs(5, 845, '1');
    const v = windowValues(
      [
        ref,
        obs(60_000, 60_500, '1.3', 'TICK'),
        obs(120_000, 120_500, '0.9', 'TICK'),
        obs(-60_000, 1_000, '5', 'TICK'), // sent before the start: never counted
        obs(W.endMs - S, W.endMs - S + 400, '0.1', 'TICK'), // at the end: never counted
      ],
      W,
    );
    expect(v.count).toBe(3);
    expect(v.highest?.price).toBe('1.3');
    expect(v.lowest?.price).toBe('0.9');
    expect(v.maxGapMs).toBe(60_000); // 60 500 → 120 500 (start → 845 and 845 → 60 500 are shorter)
    const e = evaluateQuote({
      mapping: ok,
      window: W,
      reference: ref,
      values: v,
      latestRequestStartedMs: S + 120_000,
      cmcPriceUsd: null,
    });
    expect(e).toMatchObject({ status: 'ACTIVE', terminal: false });
    expect(e.highestReturnPct?.toFixed()).toBe('30');
    expect(e.lowestReturnPct?.toFixed()).toBe('-10');
  });
  it('closes only once a request was sent at or after the end; never FINAL', () => {
    const ref = obs(5, 845, '1');
    const base = { mapping: ok, window: W, values: windowValues([ref], W), cmcPriceUsd: null };
    expect(
      evaluateQuote({ ...base, reference: ref, latestRequestStartedMs: W.endMs - 1 }).status,
    ).toBe('ACTIVE');
    expect(evaluateQuote({ ...base, reference: ref, latestRequestStartedMs: W.endMs }).status).toBe(
      'CLOSED',
    );
    expect(
      evaluateQuote({ ...base, reference: null, latestRequestStartedMs: W.endMs }).status,
    ).toBe('NO_REFERENCE');
    expect(evaluateQuote({ ...base, reference: null, latestRequestStartedMs: S }).status).toBe(
      'PENDING',
    );
  });
});

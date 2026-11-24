import { describe, expect, it } from 'vitest';

import { D } from '../../common/utils/decimal.js';

import type { ResolvedPair } from '../strategy/index.js';

import {
  type Bar,
  type ListingDecision,
  type StatusInput,
  classifyEligibility,
  computeExtremes,
  coverage,
  entryDeviatesFromCmc,
  futuresAtSignal,
  lbankContractFromUrl,
  lbankSpotSymbolFromUrl,
  neededFromMs,
  observationStatus,
  observationWindow,
  pctChange,
  resolveSpotPair,
  selectEntry,
  spotAtSignal,
} from './observation-rules.js';
import { FINALIZE_RETRY_MS, MINUTE_MS, WINDOW_MS } from './observation.constants.js';

/** Every value below is SYNTHETIC test data unless a comment says it was recorded from LBank. */
const T = (s: string) => new Date(s).getTime();
const bar = (ms: number, o: string, h: string, l: string, c: string, v = '10'): Bar => ({
  openMs: ms,
  open: new D(o),
  high: new D(h),
  low: new D(l),
  close: new D(c),
  volume: new D(v),
});
/** Contiguous minutes from `fromMs`, flat at `price` with volume 10 unless `at` overrides a minute. */
function series(fromMs: number, n: number, price = '1', at: Record<number, Bar> = {}): Bar[] {
  return Array.from(
    { length: n },
    (_, i) => at[i] ?? bar(fromMs + i * MINUTE_MS, price, price, price, price),
  );
}

describe('observation window (exactly t0 + 168 h)', () => {
  it('t0 inside a minute: entry from the next minute, the straddling final minute is not observed', () => {
    const w = observationWindow(new Date('2026-11-26T00:07:00.078Z'));
    expect(new Date(w.cutoffMs).toISOString()).toBe('2026-12-03T00:07:00.078Z');
    expect(new Date(w.entryFromMs).toISOString()).toBe('2026-11-26T00:08:00.000Z');
    expect(new Date(w.endExclusiveMs).toISOString()).toBe('2026-12-03T00:07:00.000Z');
    expect(w.expectedBars).toBe(10_079);
    expect(w.startUnobservedMs).toBe(59_922);
    expect(w.boundaryUnobservedMs).toBe(78);
  });

  it('t0 on a minute: 10 080 bars, nothing unobserved; never extended to the end of a UTC day', () => {
    const w = observationWindow(new Date('2026-11-26T14:00:00.000Z'));
    expect(w.cutoffMs - w.t0Ms).toBe(WINDOW_MS);
    expect(new Date(w.endExclusiveMs).toISOString()).toBe('2026-12-03T14:00:00.000Z');
    expect(w.expectedBars).toBe(10_080);
    expect(w.startUnobservedMs).toBe(0);
    expect(w.boundaryUnobservedMs).toBe(0);
  });

  it('a manual run time (19:48:44.796, as on 10 Nov) leaves 15.2 s before and 44.8 s after unobserved', () => {
    const w = observationWindow(new Date('2026-11-10T19:48:44.796Z'));
    expect(w.expectedBars).toBe(10_079);
    expect(w.startUnobservedMs).toBe(15_204);
    expect(w.boundaryUnobservedMs).toBe(44_796);
  });
});

describe('entry reference (OPEN of the first bar opening at or after t0)', () => {
  const t0 = new Date('2026-11-26T00:07:00.078Z');
  const w = observationWindow(t0);
  const before = T('2026-11-26T00:07:00.000Z'); // opened 78 ms before the signal: never the entry

  it('never uses the bar that opened before the signal', () => {
    const bars = [bar(before, '5', '9', '1', '5'), bar(w.entryFromMs, '2', '2.5', '1.5', '2')];
    const e = selectEntry(bars, w, w.entryFromMs + 10 * MINUTE_MS);
    expect(e).toMatchObject({ kind: 'ok', delayMs: 59_922 });
    if (e.kind === 'ok') expect(e.price.toFixed()).toBe('2');
  });

  it('t0 exactly on a minute: the bar opening at t0 is the entry (delay 0)', () => {
    const w0 = observationWindow(new Date('2026-11-26T14:00:00.000Z'));
    const e = selectEntry([bar(w0.t0Ms, '3', '3', '3', '3')], w0, w0.t0Ms + MINUTE_MS);
    expect(e).toMatchObject({ kind: 'ok', delayMs: 0 });
  });

  it('one missing bar is tolerated (≤ 2 min); a later first bar is ENTRY too late, never shown as t0', () => {
    expect(
      selectEntry(
        [bar(w.entryFromMs + MINUTE_MS, '2', '2', '2', '2')],
        w,
        w.entryFromMs + 5 * MINUTE_MS,
      ),
    ).toMatchObject({
      kind: 'ok',
      delayMs: 119_922,
    });
    expect(
      selectEntry(
        [bar(w.entryFromMs + 2 * MINUTE_MS, '2', '2', '2', '2')],
        w,
        w.entryFromMs + 5 * MINUTE_MS,
      ),
    ).toMatchObject({
      kind: 'too_late',
      delayMs: 179_922,
    });
  });

  it('pending while the entry minutes are not fetched; none once they were answered without a bar', () => {
    expect(selectEntry([], w, null)).toEqual({ kind: 'pending' });
    expect(selectEntry([], w, w.entryFromMs)).toEqual({ kind: 'pending' });
    expect(selectEntry([], w, w.entryFromMs + 10 * MINUTE_MS)).toEqual({ kind: 'none' });
  });

  it('stale when no bar with trades lies within 60 min before the entry bar (filler bars do not count)', () => {
    const lastTrade = w.entryFromMs - 61 * MINUTE_MS;
    const filler = (ms: number) => bar(ms, '2', '2', '2', '2', '0');
    const bars = [
      bar(lastTrade, '2', '2', '2', '2'),
      ...Array.from({ length: 60 }, (_, i) => filler(lastTrade + (i + 1) * MINUTE_MS)),
      filler(w.entryFromMs),
    ];
    expect(selectEntry(bars, w, w.entryFromMs + MINUTE_MS)).toMatchObject({
      kind: 'ok',
      stale: true,
      lastTradeBarMs: null,
    });
    const fresh = [bar(w.entryFromMs - 59 * MINUTE_MS, '2', '2', '2', '2'), filler(w.entryFromMs)];
    expect(selectEntry(fresh, w, w.entryFromMs + MINUTE_MS)).toMatchObject({
      kind: 'ok',
      stale: false,
      lastTradeBarMs: w.entryFromMs - 59 * MINUTE_MS,
    });
  });
});

describe('extremes (LBank Spot bars with trades only)', () => {
  const from = T('2026-11-26T00:08:00Z');

  it('recorded 0G event (10 Nov 19:48:44Z): entry 0.1435, High 0.1632, Low 0.1198 → +13.7282229965 % / −16.5156794425 %', () => {
    // Values recorded from api.lbkex.com on 2026-11-24 (0g_usdt, 1-minute bars).
    const rise = pctChange(new D('0.1632'), new D('0.1435'));
    const drop = pctChange(new D('0.1198'), new D('0.1435'));
    expect(rise.toDecimalPlaces(10).toFixed()).toBe('13.7282229965');
    expect(drop.toDecimalPlaces(10).toFixed()).toBe('-16.5156794425');
  });

  it('ignores filler bars (no trades): their O = H = L = C may be a pre-entry price', () => {
    const bars = [
      bar(from, '1', '1.1', '0.9', '1'),
      bar(from + MINUTE_MS, '5', '5', '5', '5', '0'), // filler carrying an old close
      bar(from + 2 * MINUTE_MS, '1', '1.2', '0.95', '1.1'),
    ];
    const x = computeExtremes(bars, from, from + 3 * MINUTE_MS)!;
    expect(x.high.toFixed()).toBe('1.2');
    expect(x.low.toFixed()).toBe('0.9');
    expect(x.tradedBars).toBe(2);
  });

  it('ties go to the earliest bar; one bar holding both extremes has an unknown order', () => {
    const tie = [bar(from, '1', '2', '0.5', '1'), bar(from + MINUTE_MS, '1', '2', '0.5', '1')];
    const x = computeExtremes(tie, from, from + 2 * MINUTE_MS)!;
    expect([x.highBarMs, x.lowBarMs]).toEqual([from, from]);
    expect(x.order).toBe('SAME_BAR');
  });

  it('orders the High and Low bars, and the lowest Low up to (and including) the High bar', () => {
    const bars = [
      bar(from, '1', '1.05', '0.97', '1'),
      bar(from + MINUTE_MS, '1', '1.02', '0.80', '0.9'), // the overall Low, before the High
      bar(from + 2 * MINUTE_MS, '0.9', '1.50', '0.85', '1.4'), // the High
      bar(from + 3 * MINUTE_MS, '1.4', '1.45', '0.70', '0.8'), // a lower Low after the High
    ];
    const x = computeExtremes(bars, from, from + 4 * MINUTE_MS)!;
    expect(x.high.toFixed()).toBe('1.5');
    expect(x.low.toFixed()).toBe('0.7');
    expect(x.order).toBe('HIGH_FIRST');
    expect(x.lowBeforeHigh.toFixed()).toBe('0.8');
    expect(x.lowBeforeHighBarMs).toBe(from + MINUTE_MS);
  });

  it('never takes the High / Low of the bar that straddles the cutover', () => {
    const w = observationWindow(new Date('2026-11-26T00:07:00.078Z'));
    const bars = [
      bar(w.endExclusiveMs - MINUTE_MS, '1', '1.1', '0.9', '1'),
      bar(w.endExclusiveMs, '1', '99', '0.01', '1'),
    ];
    const x = computeExtremes(bars, w.entryFromMs, w.endExclusiveMs)!;
    expect(x.high.toFixed()).toBe('1.1');
    expect(x.low.toFixed()).toBe('0.9');
  });

  it('no bar with trades: no extremes', () => {
    expect(
      computeExtremes([bar(from, '1', '1', '1', '1', '0')], from, from + MINUTE_MS),
    ).toBeNull();
  });
});

describe('coverage', () => {
  const w = observationWindow(new Date('2026-11-26T00:00:00.000Z'));

  it('lists minutes the source answered without a bar, and counts only what has been fetched', () => {
    const bars = series(w.entryFromMs, 10).filter((_, i) => i < 3 || i > 5);
    const c = coverage(bars, w, w.entryFromMs + 10 * MINUTE_MS);
    expect(c.expectedSoFar).toBe(10);
    expect(c.presentBars).toBe(7);
    expect(c.missingBars).toBe(3);
    expect(c.missingRanges).toEqual([
      [w.entryFromMs + 3 * MINUTE_MS, w.entryFromMs + 6 * MINUTE_MS],
    ]);
  });

  it('a gap at the end of what was fetched is missing; nothing beyond the window counts', () => {
    const c = coverage(series(w.entryFromMs, 5), w, w.entryFromMs + 8 * MINUTE_MS);
    expect(c.missingRanges).toEqual([
      [w.entryFromMs + 5 * MINUTE_MS, w.entryFromMs + 8 * MINUTE_MS],
    ]);
    const all = coverage([], w, w.endExclusiveMs + 50 * MINUTE_MS);
    expect(all.observedThroughMs).toBe(w.endExclusiveMs);
    expect(all.expectedSoFar).toBe(10_080);
  });

  it('the next fetch starts an hour before the entry (look-back), or where the pair is synced to', () => {
    expect(neededFromMs(w, null)).toBe(w.entryFromMs - 60 * MINUTE_MS);
    expect(neededFromMs(w, w.entryFromMs + 5 * MINUTE_MS)).toBe(w.entryFromMs + 5 * MINUTE_MS);
    expect(neededFromMs(w, w.endExclusiveMs)).toBeNull();
  });
});

describe('status (ACTIVE → FINAL, or an explicit terminal status)', () => {
  const t0 = new Date('2026-11-26T00:00:00.000Z');
  const w = observationWindow(t0);
  const full = series(w.entryFromMs - 30 * MINUTE_MS, 30 + w.expectedBars);
  const yes: ListingDecision = { status: 'YES', reasons: [] };
  const base = (over: Partial<StatusInput> = {}): StatusInput => {
    const synced = over.cov?.observedThroughMs ?? w.endExclusiveMs;
    const entry = selectEntry(full, w, synced);
    return {
      nowMs: w.cutoffMs,
      w,
      mapping: 'OK',
      mappingReasons: [],
      spot: yes,
      entry,
      entryDeviates: false,
      cov: coverage(full, w, synced),
      extremes: computeExtremes(full, w.entryFromMs, w.endExclusiveMs),
      pairUnsupported: false,
      fetchError: null,
      ...over,
    };
  };

  it('FINAL exactly at t0 + 168 h when every expected bar is present', () => {
    expect(observationStatus(base())).toEqual({ status: 'FINAL', terminal: true, reasons: [] });
  });

  it('ACTIVE while the window runs (provisional extremes)', () => {
    const now = w.t0Ms + 3 * 3_600_000;
    const s = observationStatus(base({ nowMs: now, cov: coverage(full, w, now) }));
    expect(s).toEqual({ status: 'ACTIVE', terminal: false, reasons: ['WINDOW_OPEN'] });
  });

  it('missing bars: ACTIVE while gaps are retried, PARTIAL after (never FINAL)', () => {
    const gappy = full.filter((b) => b.openMs !== w.entryFromMs + 500 * MINUTE_MS);
    const cov = coverage(gappy, w, w.endExclusiveMs);
    expect(observationStatus(base({ cov }))).toMatchObject({
      status: 'ACTIVE',
      reasons: ['MISSING_BARS'],
    });
    expect(observationStatus(base({ cov, nowMs: w.cutoffMs + FINALIZE_RETRY_MS + 1 }))).toEqual({
      status: 'PARTIAL',
      terminal: true,
      reasons: ['MISSING_BARS'],
    });
  });

  it('a stale entry (last trade over an hour before) ends PARTIAL', () => {
    const e = selectEntry(full, w, w.endExclusiveMs);
    const stale = e.kind === 'ok' ? { ...e, stale: true } : e;
    expect(observationStatus(base({ entry: stale }))).toMatchObject({
      status: 'PARTIAL',
      reasons: ['ENTRY_STALE'],
    });
  });

  it('window over but not fetched to the end: ACTIVE, then PARTIAL (FETCH_INCOMPLETE)', () => {
    const cov = coverage(full, w, w.endExclusiveMs - 60 * MINUTE_MS);
    expect(observationStatus(base({ cov }))).toMatchObject({
      status: 'ACTIVE',
      reasons: ['FETCH_PENDING'],
    });
    expect(
      observationStatus(base({ cov, nowMs: w.cutoffMs + FINALIZE_RETRY_MS + 1 })),
    ).toMatchObject({
      status: 'PARTIAL',
      reasons: ['FETCH_INCOMPLETE'],
    });
  });

  it('mapping and Spot availability failures are terminal at once', () => {
    expect(
      observationStatus(base({ mapping: 'AMBIGUOUS', mappingReasons: ['MULTIPLE_USDT_PAIRS'] })),
    ).toEqual({
      status: 'MAPPING_AMBIGUOUS',
      terminal: true,
      reasons: ['MULTIPLE_USDT_PAIRS'],
    });
    expect(
      observationStatus(base({ mapping: 'NONE', mappingReasons: ['NO_USDT_PAIR'] })),
    ).toMatchObject({
      status: 'DATA_UNAVAILABLE',
      reasons: ['NO_USDT_PAIR'],
    });
    expect(
      observationStatus(base({ spot: { status: 'NO', reasons: ['PAIR_UNSUPPORTED_BY_API'] } })),
    ).toMatchObject({
      status: 'DATA_UNAVAILABLE',
    });
    expect(observationStatus(base({ entryDeviates: true }))).toMatchObject({
      status: 'MAPPING_AMBIGUOUS',
      reasons: ['PRICE_DEVIATION_FROM_CMC'],
    });
  });

  it('entry problems: too late, none, never fetched, delisted pair', () => {
    const late = { kind: 'too_late', bar: full[0]!, delayMs: 300_000 } as const;
    expect(observationStatus(base({ entry: late }))).toMatchObject({
      status: 'DATA_UNAVAILABLE',
      reasons: ['ENTRY_TOO_LATE'],
    });
    expect(observationStatus(base({ entry: { kind: 'none' } }))).toMatchObject({
      status: 'DATA_UNAVAILABLE',
      reasons: ['ENTRY_UNAVAILABLE'],
    });
    expect(
      observationStatus(base({ entry: { kind: 'pending' }, nowMs: w.t0Ms + MINUTE_MS })),
    ).toMatchObject({
      status: 'ACTIVE',
      reasons: ['ENTRY_PENDING'],
    });
    expect(
      observationStatus(
        base({ entry: { kind: 'pending' }, nowMs: w.cutoffMs + FINALIZE_RETRY_MS + 1 }),
      ),
    ).toMatchObject({
      status: 'DATA_UNAVAILABLE',
    });
    expect(
      observationStatus(base({ entry: { kind: 'pending' }, pairUnsupported: true })),
    ).toMatchObject({
      status: 'DATA_UNAVAILABLE',
      reasons: ['PAIR_UNSUPPORTED_BY_API', 'ENTRY_UNAVAILABLE'],
    });
  });

  it('unknown Spot availability: ACTIVE, then ELIGIBILITY_UNKNOWN; no trades in the window: PARTIAL', () => {
    const unknown: ListingDecision = { status: 'UNKNOWN', reasons: ['SPOT_EVIDENCE_MISSING'] };
    expect(observationStatus(base({ spot: unknown }))).toMatchObject({ status: 'ACTIVE' });
    expect(
      observationStatus(base({ spot: unknown, nowMs: w.cutoffMs + FINALIZE_RETRY_MS + 1 })),
    ).toMatchObject({
      status: 'ELIGIBILITY_UNKNOWN',
    });
    expect(observationStatus(base({ extremes: null }))).toMatchObject({
      status: 'PARTIAL',
      reasons: ['NO_TRADES_IN_WINDOW'],
    });
  });
});

describe('LBank Spot pair of a CMC event (by CMC id, LBank symbol from the market URL)', () => {
  const pair = (
    quote: string,
    url: string | null,
    mapping: ResolvedPair['mapping'] = 'OK',
  ): ResolvedPair => ({
    marketPair: `0G/${quote}`,
    baseSymbol: '0G',
    quoteSymbol: quote,
    mapping,
    trading: 'TRADING',
    tradingSource: 'listing',
    volumeUsd: '1',
    lastUpdated: null,
    marketUrl: url,
    evidence: ["listed in CMC's LBank Spot markets"],
    decisionIds: [],
  });
  const url = (s: string) => `https://www.lbank.com/en-US/trade/${s}/?icode=670BP`;

  it('takes the single USDT pair and LBank’s own symbol', () => {
    const m = resolveSpotPair([pair('USDC', url('0g_usdc')), pair('USDT', url('0g_usdt'))]);
    expect(m).toMatchObject({
      status: 'OK',
      symbol: '0g_usdt',
      base: '0G',
      quote: 'USDT',
      reasons: [],
    });
  });

  it('no USDT pair, several USDT pairs, or no verifiable symbol is not a guess', () => {
    expect(resolveSpotPair([pair('USDC', url('0g_usdc'))])).toMatchObject({
      status: 'NONE',
      reasons: ['NO_USDT_PAIR'],
    });
    expect(
      resolveSpotPair([pair('USDT', url('0g_usdt')), pair('USDT', url('0gx_usdt'))]),
    ).toMatchObject({
      status: 'AMBIGUOUS',
      reasons: ['MULTIPLE_USDT_PAIRS'],
    });
    expect(resolveSpotPair([pair('USDT', null)])).toMatchObject({
      status: 'AMBIGUOUS',
      reasons: ['PAIR_SYMBOL_UNVERIFIED'],
    });
    expect(resolveSpotPair([pair('USDT', url('0g_usdt'), 'AMBIGUOUS')])).toMatchObject({
      status: 'NONE',
    });
  });

  it('reads LBank symbols from CMC market URLs (recorded formats)', () => {
    expect(lbankSpotSymbolFromUrl('https://www.lbank.com/en-US/trade/btc_usdt/?icode=670BP')).toBe(
      'btc_usdt',
    );
    expect(lbankSpotSymbolFromUrl('https://www.lbank.com/trade/1mbabydoge_usdt')).toBe(
      '1mbabydoge_usdt',
    );
    expect(lbankSpotSymbolFromUrl('https://example.com/trade/btc_usdt/')).toBeNull();
    expect(lbankContractFromUrl('https://www.lbank.com/futures/soxlusdt/?icode=670BP')).toBe(
      'SOXLUSDT',
    );
  });

  it('the CMC price only checks identity (25 %), it is never part of a return', () => {
    expect(entryDeviatesFromCmc(new D('0.1435'), new D('0.142987979'))).toBe(false);
    expect(entryDeviatesFromCmc(new D('1.26'), new D('1'))).toBe(true);
    expect(entryDeviatesFromCmc(new D('0.75'), new D('1'))).toBe(false);
  });
});

describe('Spot / Futures at the signal and the eligibility class', () => {
  it('Spot: a series spanning t0 shows availability; NO needs LBank’s own answer near the signal', () => {
    const spans = {
      unsupportedNearSignal: false,
      barBeforeT0: true,
      entryBar: true,
      tradeNearSignal: true,
    };
    expect(spotAtSignal({ ...spans, listed: true })).toMatchObject({
      status: 'YES',
      trading: 'TRADES_OBSERVED',
    });
    expect(spotAtSignal({ ...spans, listed: null })).toMatchObject({ status: 'YES' });
    expect(spotAtSignal({ ...spans, listed: null, tradeNearSignal: false })).toMatchObject({
      status: 'YES',
      trading: 'NO_RECENT_TRADES',
      reasons: ['NO_TRADES_NEAR_SIGNAL'],
    });
    expect(spotAtSignal({ ...spans, listed: false })).toMatchObject({
      status: 'UNKNOWN',
      reasons: ['SPOT_EVIDENCE_CONFLICT'],
    });
    const none = { barBeforeT0: false, entryBar: false, tradeNearSignal: false };
    expect(spotAtSignal({ ...none, listed: null, unsupportedNearSignal: true })).toMatchObject({
      status: 'NO',
    });
    expect(spotAtSignal({ ...none, listed: false, unsupportedNearSignal: false })).toMatchObject({
      status: 'NO',
    });
    expect(spotAtSignal({ ...none, listed: null, unsupportedNearSignal: false })).toMatchObject({
      status: 'UNKNOWN',
    });
  });

  it('Futures: evidence before (CMC by id) and after (LBank list) the signal must agree', () => {
    const lbank = (base: string, volume: string | null) => ({
      contracts: new Map([
        [`${base}USDT`, { base, volume24h: volume === null ? null : new D(volume) }],
      ]),
    });
    const yes = { status: 'YES' as const, contracts: ['ABCUSDT'], reason: null };
    const no = { status: 'NO' as const, contracts: [], reason: null };
    expect(futuresAtSignal({ cmc: yes, lbank: null, coinSymbol: 'ABC' })).toEqual({
      status: 'UNKNOWN',
      reasons: ['FUTURES_SNAPSHOT_MISSING'],
    });
    expect(futuresAtSignal({ cmc: yes, lbank: lbank('ABC', '1200.5'), coinSymbol: 'ABC' })).toEqual(
      { status: 'YES', reasons: [] },
    );
    expect(
      futuresAtSignal({ cmc: yes, lbank: lbank('ABC', '0'), coinSymbol: 'ABC' }),
    ).toMatchObject({ status: 'UNKNOWN' });
    expect(
      futuresAtSignal({ cmc: yes, lbank: lbank('XYZ', '5'), coinSymbol: 'ABC' }),
    ).toMatchObject({
      status: 'UNKNOWN',
      reasons: ['FUTURES_EVIDENCE_CONFLICT'],
    });
    expect(futuresAtSignal({ cmc: no, lbank: lbank('ABC', '5'), coinSymbol: 'ABC' })).toMatchObject(
      {
        status: 'UNKNOWN',
        reasons: ['FUTURES_TICKER_UNVERIFIED'],
      },
    );
    expect(futuresAtSignal({ cmc: no, lbank: lbank('XYZ', '5'), coinSymbol: 'ABC' })).toEqual({
      status: 'NO',
      reasons: [],
    });
    expect(
      futuresAtSignal({
        cmc: { status: 'UNKNOWN', contracts: [], reason: 'LIST_STALE' },
        lbank: lbank('ABC', '5'),
        coinSymbol: 'ABC',
      }),
    ).toEqual({ status: 'UNKNOWN', reasons: ['FUTURES_LIST:LIST_STALE'] });
  });

  it('classes', () => {
    expect(classifyEligibility('OK', 'YES', 'YES')).toBe('SPOT_AND_FUTURES');
    expect(classifyEligibility('OK', 'YES', 'NO')).toBe('SPOT_ONLY');
    expect(classifyEligibility('OK', 'YES', 'UNKNOWN')).toBe('SPOT_FUTURES_UNKNOWN');
    expect(classifyEligibility('OK', 'NO', 'YES')).toBe('SPOT_UNAVAILABLE');
    expect(classifyEligibility('NONE', 'UNKNOWN', 'UNKNOWN')).toBe('SPOT_UNAVAILABLE');
    expect(classifyEligibility('OK', 'UNKNOWN', 'YES')).toBe('SPOT_UNKNOWN');
    expect(classifyEligibility('AMBIGUOUS', 'YES', 'YES')).toBe('MAPPING_AMBIGUOUS');
    expect(classifyEligibility('PENDING', 'UNKNOWN', 'UNKNOWN')).toBe('PENDING');
  });
});

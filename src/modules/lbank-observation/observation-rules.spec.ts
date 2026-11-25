import { describe, expect, it } from 'vitest';

import { D } from '../../common/utils/decimal.js';

import type { ResolvedPair } from '../strategy/index.js';

import { type AssessInput, type Assessment, assess } from './observation-assess.js';
import {
  type Bar,
  type MinuteCheck,
  type PairSync,
  type Trade,
  barMap,
  classifyEligibility,
  coverage,
  deviatesFromCmc,
  findReference,
  futuresAtSignal,
  lbankContractFromUrl,
  lbankSpotSymbolFromUrl,
  observationWindow,
  rangeExtreme,
  resolveSpotPair,
  spotAtSignal,
} from './observation-rules.js';
import { FINALIZE_RETRY_MS, MINUTE_MS, WINDOW_MS } from './observation.constants.js';

/** Every value below is SYNTHETIC test data unless a comment says it was recorded from LBank. */
const T = (s: string) => new Date(s).getTime();
const M = MINUTE_MS;
const bar = (ms: number, o: string, h: string, l: string, c: string, v = '10'): Bar => ({
  openMs: ms,
  open: new D(o),
  high: new D(h),
  low: new D(l),
  close: new D(c),
  volume: new D(v),
});
/** A minute without trades, as LBank fills it: O = H = L = C = the previous close, volume 0. */
const flat = (ms: number, price: string) => bar(ms, price, price, price, price, '0');
const trade = (id: string, ms: number, price: string, qty = '1', ord = 0): Trade => ({
  id,
  timeMs: ms,
  ord,
  price: new D(price),
  qty: new D(qty),
  buyerMaker: null,
});
const verified = (minuteMs: number, trades: Trade[]): MinuteCheck => ({
  minuteMs,
  status: 'VERIFIED',
  trades,
  tradeCount: trades.length,
  qtySum: trades.reduce((s, t) => s.plus(t.qty), new D(0)),
  candleVolume: null,
  attempts: 1,
  error: null,
});
const failed = (minuteMs: number, status: MinuteCheck['status']): MinuteCheck => ({
  minuteMs,
  status,
  trades: [],
  tradeCount: null,
  qtySum: null,
  candleVolume: null,
  attempts: 1,
  error: status,
});
/** Zero-volume minutes [fromMs, toMs) at `price`. */
const flats = (fromMs: number, toMs: number, price: string) => {
  const out: Bar[] = [];
  for (let m = fromMs; m < toMs; m += M) out.push(flat(m, price));
  return out;
};
const syncOf = (syncedUntilMs: number | null, nowMs: number, over: Partial<PairSync> = {}) => ({
  syncedUntilMs,
  unsupported: false,
  lastFetchFailed: false,
  closedNowMs: Math.floor((nowMs - 5_000) / M) * M,
  ...over,
});

/** A pair's market: candles plus the complete trade lists LBank would return per minute. */
class Market {
  bars = new Map<number, Bar>();
  trades = new Map<number, Trade[]>();
  checks = new Map<number, MinuteCheck>();
  checked: number[] = [];
  set(...bars: Bar[]) {
    for (const b of bars) this.bars.set(b.openMs, b);
    return this;
  }
  /** A traded minute: its candle (High / Low may be the carried OPEN) and its trades. */
  traded(b: Bar, trades: Trade[]) {
    this.bars.set(b.openMs, b);
    this.trades.set(b.openMs, trades);
    return this;
  }
  sorted() {
    return [...this.bars.values()].sort((a, b) => a.openMs - b.openMs);
  }
}

/**
 * The job's loop without I/O: assess, check the minutes it asks for (from the market's trade
 * lists), repeat until nothing more is asked.
 */
function solve(mk: Market, over: Partial<AssessInput> & Pick<AssessInput, 'now' | 'start'>) {
  const bars = mk.sorted();
  const input = (): AssessInput => ({
    t0: over.start ?? over.now,
    cmcPrice: new D('1'),
    mapping: 'OK',
    mappingReasons: [],
    bars,
    barsByMinute: barMap(bars),
    checks: mk.checks,
    sync: syncOf(bars.at(-1) ? bars.at(-1)!.openMs + M : null, over.now.getTime()),
    unsupportedSince: null,
    spotListed: true,
    futures: { status: 'UNKNOWN', reasons: ['FUTURES_SNAPSHOT_MISSING'] },
    fetchError: null,
    mappingSnapshotOld: false,
    ...over,
  });
  let a: Assessment = assess(input());
  for (let round = 0; round < 50 && a.needs.length; round++) {
    for (const m of a.needs) {
      mk.checked.push(m);
      mk.checks.set(m, verified(m, mk.trades.get(m) ?? []));
    }
    a = assess(input());
  }
  return a;
}

describe('observation window: exactly [start, start + 168 h)', () => {
  it('a start inside a minute: 10 081 touched minutes, the first and last partial', () => {
    const w = observationWindow(new Date('2026-11-25T00:15:32.457Z'));
    expect(w.endMs - w.startMs).toBe(WINDOW_MS);
    expect(new Date(w.endMs).toISOString()).toBe('2026-12-02T00:15:32.457Z');
    expect(new Date(w.startMinuteMs).toISOString()).toBe('2026-11-25T00:15:00.000Z');
    expect(new Date(w.endMinuteExclusiveMs).toISOString()).toBe('2026-12-02T00:16:00.000Z');
    expect(w.minutes).toBe(10_081);
    expect(new Date(w.partialEndMinuteMs!).toISOString()).toBe('2026-12-02T00:15:00.000Z');
  });

  it('a start on a whole minute: 10 080 minutes; never extended to the end of a UTC day', () => {
    const w = observationWindow(new Date('2026-11-26T14:00:00.000Z'));
    expect(new Date(w.endMs).toISOString()).toBe('2026-12-03T14:00:00.000Z');
    expect(w.minutes).toBe(10_080);
    expect(w.partialEndMinuteMs).toBeNull();
  });
});

describe('reference: the first verified LBank Spot trade at or after the start', () => {
  const S = T('2026-11-25T00:15:32.457Z');
  const m0 = Math.floor(S / M) * M;
  const now = new Date(S + 3 * 3_600_000);

  it('a candle OPEN carried from a pre-signal trade is never the reference', () => {
    // LBank's OPEN is the previous CLOSE: 0.0919 was traded before the start.
    const mk = new Market()
      .set(...flats(m0 - 60 * M, m0, '0.0919'))
      .traded(bar(m0, '0.0919', '0.0921', '0.0917', '0.092', '30'), [
        trade('pre', m0 + 10_000, '0.0921', '10'),
        trade('ref', m0 + 40_000, '0.0918', '15'),
        trade('nxt', m0 + 50_000, '0.092', '5'),
      ])
      .set(...flats(m0 + M, m0 + 120 * M, '0.092'));
    const a = solve(mk, { now, start: new Date(S) });
    expect(a.reference).toMatchObject({ status: 'VERIFIED', delayMs: 40_000 - 32_457 });
    expect(a.reference?.status === 'VERIFIED' && a.reference.trade.id).toBe('ref');
    expect(a.reference?.status === 'VERIFIED' && a.reference.trade.price.toFixed()).toBe('0.0918');
    // The pre-start trade (0.0921) is neither the reference nor the highest.
    expect(a.highest?.best?.price.toFixed()).toBe('0.092');
  });

  it('a trade exactly at the start is included; one exactly at the end is not', () => {
    const start = T('2026-11-20T12:34:20.000Z');
    const w = observationWindow(new Date(start));
    const sm = Math.floor(start / M) * M;
    const em = w.partialEndMinuteMs!;
    const mk = new Market()
      .set(...flats(sm - 60 * M, sm, '1'))
      .traded(bar(sm, '1', '9', '1', '1.2', '3'), [
        trade('before', sm + 5_000, '9'),
        trade('at-start', start, '1'),
        trade('later', sm + 50_000, '1.2'),
      ])
      .traded(bar(sm + M, '1.2', '1', '1', '1', '1'), [trade('w1', sm + M + 1_000, '1')])
      .set(...flats(sm + 2 * M, em, '1'))
      .traded(bar(em, '1', '5', '0.1', '0.1', '3'), [
        trade('in-end', em + 10_000, '0.8'),
        trade('at-end', w.endMs, '5'),
        trade('after-end', em + 30_000, '0.1'),
      ])
      .set(flat(em + M, '0.1'));
    const a = solve(mk, {
      now: new Date(w.endMs + 2 * 3_600_000),
      start: new Date(start),
      futures: { status: 'UNKNOWN', reasons: [] },
    });
    expect(a.reference?.status === 'VERIFIED' && a.reference.trade.id).toBe('at-start');
    expect(a.reference?.status === 'VERIFIED' && a.reference.delayMs).toBe(0);
    // First partial minute: only trades at/after the reference; last: only before the end.
    expect(a.highest?.best?.id).toBe('later');
    expect(a.lowest?.best?.id).toBe('in-end');
    expect(a.highestPct?.toFixed()).toBe('20');
    expect(a.lowestPct?.toFixed()).toBe('-20');
    // A complete window with Futures UNKNOWN is FINAL: Futures never blocks a Spot result.
    expect(a.status).toEqual({ status: 'FINAL', terminal: true, reasons: [] });
    expect(a.eligibility).toBe('SPOT_FUTURES_UNKNOWN');
  });

  it('the first trade much later than the signal: exact delay, marked delayed, still observed', () => {
    const mk = new Market()
      .set(...flats(m0 - 60 * M, m0 + 37 * M, '0.00278999'))
      .traded(bar(m0 + 37 * M, '0.00278999', '0.00278999', '0.0027899', '0.0027899', '870.99'), [
        trade('first', m0 + 37 * M + 37_385, '0.0027899', '870.99'),
      ])
      .set(...flats(m0 + 38 * M, m0 + 180 * M, '0.0027899'));
    const a = solve(mk, { now, start: new Date(S) });
    expect(a.reference).toMatchObject({
      status: 'VERIFIED',
      delayMs: 37 * M + 37_385 - 32_457,
      silentMinutes: 36,
      delayed: true,
    });
    expect(a.flags).toContain('REFERENCE_DELAYED');
  });

  it('"delayed" needs one whole silent minute after the start (operator rule), not a threshold', () => {
    const at = (offsetMs: number) => {
      const mk = new Market()
        .set(...flats(m0 - 60 * M, m0, '1'))
        .set(flat(m0, '1'))
        .set(...flats(m0 + M, Math.floor((S + offsetMs) / M) * M, '1'))
        .traded(bar(Math.floor((S + offsetMs) / M) * M, '1', '1', '1', '1', '1'), [
          trade('t', S + offsetMs, '1'),
        ]);
      const a = solve(mk, { now, start: new Date(S) });
      return a.reference?.status === 'VERIFIED' ? a.reference.delayed : null;
    };
    expect(at(58_000)).toBe(false); // 00:16:30.457: part of 00:15 and 00:16, no whole minute
    expect(at(92_543)).toBe(true); // 00:17:05: the whole minute 00:16 was silent
  });

  it('several trades in the reference millisecond: LBank’s order picks it, a price tie is flagged', () => {
    const mk = new Market()
      .set(...flats(m0 - 60 * M, m0, '2'))
      .traded(bar(m0, '2', '2.02', '2', '2.02', '3'), [
        trade('a', S + 1_000, '2.01', '1', 0),
        trade('b', S + 1_000, '2.02', '1', 1),
        trade('c', S + 1_000, '2.01', '1', 2),
      ])
      .set(...flats(m0 + M, m0 + 5 * M, '2.01'));
    const a = solve(mk, { now, start: new Date(S) });
    expect(a.reference?.status === 'VERIFIED' && a.reference.trade.id).toBe('a');
    expect(a.flags).toContain('REFERENCE_SAME_MS_TIE');
  });

  it('a missing candle stops the search (never skipped); an unchecked minute asks for its trades', () => {
    const w = observationWindow(new Date(S));
    const bars = barMap([...flats(m0 - 60 * M, m0, '1'), flat(m0 + M, '1')]);
    const sync = syncOf(m0 + 2 * M, now.getTime());
    expect(findReference(w, bars, new Map(), sync)).toEqual({
      status: 'PENDING',
      minuteMs: m0,
      why: 'NO_BAR',
      needs: [],
    });
    const traded = barMap([bar(m0, '1', '1', '1', '1', '5')]);
    expect(findReference(w, traded, new Map(), sync)).toMatchObject({
      status: 'PENDING',
      why: 'CHECK_PENDING',
      needs: [m0],
    });
    const below = new Map([[m0, failed(m0, 'TRADES_BELOW_CANDLE')]]);
    expect(findReference(w, traded, below, sync)).toMatchObject({
      status: 'PENDING',
      why: 'TRADES_BELOW_CANDLE',
    });
  });

  it('a start minute that traded only before the start moves on to the next minute', () => {
    const mk = new Market()
      .set(...flats(m0 - 60 * M, m0, '3'))
      .traded(bar(m0, '3', '3.1', '3', '3.1', '2'), [trade('early', m0 + 1_000, '3.1', '2')])
      .traded(bar(m0 + M, '3.1', '3.2', '3.2', '3.2', '1'), [trade('next', m0 + M + 5, '3.2')])
      .set(...flats(m0 + 2 * M, m0 + 10 * M, '3.2'));
    const a = solve(mk, { now, start: new Date(S) });
    expect(a.reference?.status === 'VERIFIED' && a.reference.trade.id).toBe('next');
    expect(a.reference?.status === 'VERIFIED' && a.reference.delayed).toBe(false);
  });
});

describe('extremes: verified trades only, located with candles', () => {
  const S = T('2026-11-25T00:15:32.457Z');
  const m0 = Math.floor(S / M) * M;
  const now = new Date(S + 6 * 3_600_000);

  it('a candle High that is only the carried OPEN is passed over; the next candidate is checked', () => {
    // Recorded pattern (twt_usdt 00:08, re_usdt 00:08): High = OPEN without a trade at that price.
    const mk = new Market()
      .set(...flats(m0 - 60 * M, m0, '1'))
      .traded(bar(m0, '1', '1', '1', '1', '1'), [trade('ref', S + 500, '1')])
      .traded(bar(m0 + M, '1.05', '1.05', '1', '1.01', '10'), [
        trade('x1', m0 + M + 1_000, '1', '4'),
        trade('x2', m0 + M + 2_000, '1.01', '6'),
      ])
      .traded(bar(m0 + 2 * M, '1.01', '1.03', '1.01', '1.03', '5'), [
        trade('y1', m0 + 2 * M + 3_000, '1.02', '2'),
        trade('y2', m0 + 2 * M + 4_000, '1.03', '3'),
      ])
      .set(...flats(m0 + 3 * M, m0 + 60 * M, '1.03'));
    const a = solve(mk, { now, start: new Date(S) });
    expect(a.highest?.best?.id).toBe('y2');
    expect(a.highestPct?.toFixed()).toBe('3');
    expect(mk.checked).toContain(m0 + M); // the artefact minute was checked, then passed over
    expect(a.highest?.checked.map((c) => [c.candle, c.traded])).toEqual([
      ['1.05', '1.01'],
      ['1.03', '1.03'],
    ]);
  });

  it('ties go to the earliest trade; order follows trade times; same millisecond is unknown', () => {
    const mk = new Market()
      .set(...flats(m0 - 60 * M, m0, '1'))
      .traded(bar(m0, '1', '1', '1', '1', '1'), [trade('ref', S + 500, '1')])
      .traded(bar(m0 + 2 * M, '1', '1.5', '1', '1.5', '1'), [trade('h1', m0 + 2 * M + 10, '1.5')])
      .traded(bar(m0 + 3 * M, '1.5', '1.5', '0.5', '0.5', '2'), [
        trade('h2', m0 + 3 * M + 10, '1.5'),
        trade('l1', m0 + 3 * M + 20, '0.5'),
      ]);
    mk.set(flat(m0 + M, '1'));
    const a = solve(mk, { now, start: new Date(S) });
    expect(a.highest?.best?.id).toBe('h1');
    expect(a.lowest?.best?.id).toBe('l1');
    expect(a.order).toBe('HIGH_FIRST');
    // Lowest price from the reference through the eventual highest trade (inclusive).
    expect(a.lowBeforeHigh?.best?.id).toBe('ref');

    const same = new Market()
      .set(...flats(m0 - 60 * M, m0, '1'))
      .traded(bar(m0, '1', '1', '1', '1', '1'), [trade('ref', S + 500, '1')])
      .traded(bar(m0 + M, '1', '2', '0.5', '0.5', '2'), [
        trade('hi', m0 + M + 7, '2', '1', 0),
        trade('lo', m0 + M + 7, '0.5', '1', 1),
      ]);
    expect(solve(same, { now, start: new Date(S) }).order).toBe('SAME_MS');
  });

  it('an isolated real print is kept and flagged (single-trade minute), never removed', () => {
    // Recorded shape (tit_usdt 2026-11-25 06:42:26.747): one trade at exactly half the price.
    const mk = new Market()
      .set(...flats(m0 - 60 * M, m0, '0.0027899'))
      .traded(bar(m0, '0.0027899', '0.0027899', '0.0027899', '0.0027899', '100'), [
        trade('ref', S + 3_000, '0.0027899', '100'),
      ])
      .set(...flats(m0 + M, m0 + 120 * M, '0.0027899'))
      .traded(bar(m0 + 120 * M, '0.0027899', '0.0027899', '0.00139495', '0.00139495', '2739.66'), [
        trade('spike', m0 + 120 * M + 26_747, '0.00139495', '2739.66'),
      ])
      .set(...flats(m0 + 121 * M, m0 + 200 * M, '0.00139495'));
    const a = solve(mk, { now, start: new Date(S) });
    expect(a.lowestPct?.toFixed()).toBe('-50');
    expect(a.highestPct?.toFixed()).toBe('0');
    expect(a.flags).toEqual(expect.arrayContaining(['SINGLE_TRADE_LOW']));
    expect(a.flagsEvidence.singleTradeLow).toMatchObject({
      tradeId: 'spike',
      price: '0.00139495',
      qty: '2739.66',
      quoteValueUsdt: '3.821688717',
      minuteTrades: 1,
    });
  });

  it('an unverified candidate that could beat the best blocks; one below the best does not', () => {
    const w = observationWindow(new Date(S));
    const ref = trade('ref', S + 500, '1');
    const bars = barMap([
      bar(m0, '1', '1', '1', '1', '1'),
      bar(m0 + M, '1', '1.2', '1', '1.2', '1'),
      bar(m0 + 2 * M, '1.2', '1.1', '1', '1.1', '1'),
    ]);
    const checks = new Map([
      [m0, verified(m0, [ref])],
      [m0 + M, verified(m0 + M, [trade('h', m0 + M + 1, '1.2')])],
      [m0 + 2 * M, failed(m0 + 2 * M, 'FETCH_FAILED')],
    ]);
    const sync = syncOf(m0 + 3 * M, now.getTime());
    const e = rangeExtreme('high', { from: ref, to: { beforeMs: m0 + 3 * M } }, bars, checks, sync);
    expect(e.best?.id).toBe('h');
    expect(e.proven).toBe(true); // 1.1 cannot beat 1.2
    const checks2 = new Map(checks);
    checks2.set(m0 + M, failed(m0 + M, 'TRADES_BELOW_CANDLE'));
    const e2 = rangeExtreme(
      'high',
      { from: ref, to: { beforeMs: m0 + 3 * M } },
      bars,
      checks2,
      sync,
    );
    expect(e2.proven).toBe(false);
    expect(e2.blocking).toContainEqual(
      expect.objectContaining({ kind: 'check', state: 'TRADES_BELOW_CANDLE', fromMs: m0 + M }),
    );
    expect(e2.needs).toContain(m0 + M); // retried
    void w;
  });

  it('overlapping events of one pair: own start, reference and window from the same data', () => {
    const mk = new Market()
      .set(...flats(m0 - 60 * M, m0, '1'))
      .traded(bar(m0, '1', '1', '1', '1', '1'), [trade('r1', S + 100, '1')])
      .traded(bar(m0 + 5 * M, '1', '2', '2', '2', '1'), [trade('r2', m0 + 5 * M + 100, '2')])
      .traded(bar(m0 + 10 * M, '2', '1.5', '1.5', '1.5', '1'), [
        trade('x', m0 + 10 * M + 1, '1.5'),
      ]);
    for (let m = m0 + M; m < m0 + 30 * M; m += M) if (!mk.bars.has(m)) mk.set(flat(m, '2'));
    const a1 = solve(mk, { now, start: new Date(S) });
    const a2 = solve(mk, { now, start: new Date(m0 + 5 * M) });
    expect(a1.reference?.status === 'VERIFIED' && a1.reference.trade.id).toBe('r1');
    expect(a2.reference?.status === 'VERIFIED' && a2.reference.trade.id).toBe('r2');
    expect(a1.highestPct?.toFixed()).toBe('100');
    expect(a2.highestPct?.toFixed()).toBe('0');
    expect(a2.lowestPct?.toFixed()).toBe('-25');
  });
});

describe('coverage and the gap states', () => {
  const S = T('2026-11-25T00:15:32.457Z');
  const m0 = Math.floor(S / M) * M;
  const w = observationWindow(new Date(S));

  it('a zero-volume candle is a verified quiet minute, not a gap', () => {
    const bars = barMap(flats(m0, m0 + 10 * M, '1'));
    const c = coverage(w, bars, syncOf(m0 + 10 * M, m0 + 10 * M + 10_000));
    expect(c).toMatchObject({
      minutesPresent: 10,
      minutesZeroVolume: 10,
      minutesMissing: 0,
      gaps: [],
    });
  });

  it('answered without a candle (NO_BAR) vs failed vs not fetched vs delisted', () => {
    const bars = barMap([flat(m0, '1'), flat(m0 + 3 * M, '1')]);
    const nowMs = m0 + 10 * M + 10_000;
    const c = coverage(w, bars, syncOf(m0 + 4 * M, nowMs));
    expect(c.gaps).toEqual([
      { fromMs: m0 + M, toMs: m0 + 3 * M, state: 'NO_BAR' },
      { fromMs: m0 + 4 * M, toMs: m0 + 10 * M, state: 'NOT_FETCHED' },
    ]);
    expect(c.minutesMissing).toBe(2);
    expect(
      coverage(w, bars, syncOf(m0 + 4 * M, nowMs, { lastFetchFailed: true })).gaps.at(-1),
    ).toMatchObject({
      state: 'FETCH_FAILED',
    });
    expect(
      coverage(w, bars, syncOf(m0 + 4 * M, nowMs, { unsupported: true })).gaps.at(-1),
    ).toMatchObject({
      state: 'PAIR_UNSUPPORTED',
    });
    expect(c.candlesComplete).toBe(false);
  });
});

describe('status: one retry policy, explicit outcomes', () => {
  const S = T('2026-11-25T00:15:32.457Z');
  const m0 = Math.floor(S / M) * M;
  const w = observationWindow(new Date(S));
  const after = (ms: number) => new Date(w.endMs + ms);
  const full = (mk: Market, price = '1') => {
    for (let m = m0 - 60 * M; m < w.endMinuteExclusiveMs; m += M)
      if (!mk.bars.has(m)) mk.set(flat(m, price));
    return mk;
  };

  it('ACTIVE while the window runs; FINAL once it has ended with verified data', () => {
    const mk = full(
      new Market().traded(bar(m0, '1', '1', '1', '1', '1'), [trade('ref', S + 900, '1')]),
    );
    const open = solve(mk, { now: new Date(S + 3_600_000), start: new Date(S) });
    expect(open.status.status).toBe('ACTIVE');
    expect(open.status.reasons).toContain('WINDOW_OPEN');
    const done = solve(mk, { now: after(10 * M), start: new Date(S) });
    expect(done.status).toMatchObject({ status: 'FINAL', terminal: true });
    expect(done.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a complete window without any trade is NO_TRADES (no percentage), not missing data', () => {
    const a = solve(full(new Market()), { now: after(10 * M), start: new Date(S) });
    expect(a.reference).toEqual({ status: 'NO_TRADE' });
    expect(a.status).toEqual({
      status: 'NO_TRADES',
      terminal: true,
      reasons: ['NO_TRADES_IN_WINDOW'],
    });
    expect(a.highestPct).toBeNull();
  });

  it('missing first minutes are retried like any gap (no ENTRY_TOO_LATE), then UNVERIFIABLE', () => {
    const mk = full(
      new Market().traded(bar(m0 + 5 * M, '1', '1', '1', '1', '1'), [
        trade('t', m0 + 5 * M + 1, '1'),
      ]),
    );
    mk.bars.delete(m0); // the source answered the start minute without a candle
    const early = solve(mk, { now: new Date(S + 10 * M), start: new Date(S) });
    expect(early.status).toMatchObject({ status: 'ACTIVE', terminal: false });
    expect(early.status.reasons).toEqual(
      expect.arrayContaining(['REFERENCE_PENDING', 'MISSING_BARS']),
    );
    const ended = solve(mk, { now: after(FINALIZE_RETRY_MS - M), start: new Date(S) });
    expect(ended.status.status).toBe('ACTIVE');
    const late = solve(mk, { now: after(FINALIZE_RETRY_MS + M), start: new Date(S) });
    expect(late.status).toMatchObject({ status: 'UNVERIFIABLE', terminal: true });
    expect(late.status.reasons).toContain('REFERENCE_UNVERIFIED');
  });

  it('a gap after the reference: ACTIVE while retried, PARTIAL after, never FINAL', () => {
    const mk = full(
      new Market().traded(bar(m0, '1', '1', '1', '1', '1'), [trade('ref', S + 900, '1')]),
    );
    mk.bars.delete(m0 + 100 * M);
    expect(solve(mk, { now: after(M), start: new Date(S) }).status.status).toBe('ACTIVE');
    const p = solve(mk, { now: after(FINALIZE_RETRY_MS + M), start: new Date(S) });
    expect(p.status).toMatchObject({ status: 'PARTIAL', terminal: true });
    expect(p.status.reasons).toContain('MISSING_BARS');
  });

  it('a source that stopped answering is never a quiet interval', () => {
    const mk = new Market().traded(bar(m0, '1', '1', '1', '1', '1'), [trade('ref', S + 900, '1')]);
    for (let m = m0 - 60 * M; m < m0 + 30 * M; m += M) if (!mk.bars.has(m)) mk.set(flat(m, '1'));
    const a = solve(mk, {
      now: after(M),
      start: new Date(S),
      sync: syncOf(m0 + 30 * M, after(M).getTime(), { lastFetchFailed: true }),
    });
    expect(a.status.status).toBe('ACTIVE');
    expect(a.cov?.gaps.at(-1)).toMatchObject({ state: 'FETCH_FAILED' });
    expect(a.reference?.status).toBe('VERIFIED');
  });

  it('mapping and Spot outcomes; the CMC deviation is a review flag, not an exclusion', () => {
    const base = { now: after(M), start: new Date(S) };
    expect(
      solve(new Market(), {
        ...base,
        mapping: 'AMBIGUOUS',
        mappingReasons: ['MULTIPLE_USDT_PAIRS'],
      }).status,
    ).toEqual({ status: 'MAPPING_AMBIGUOUS', terminal: true, reasons: ['MULTIPLE_USDT_PAIRS'] });
    expect(
      solve(new Market(), { ...base, mapping: 'NONE', mappingReasons: ['NO_USDT_PAIR'] }).status
        .status,
    ).toBe('DATA_UNAVAILABLE');
    expect(solve(new Market(), { ...base, start: null }).status).toEqual({
      status: 'ACTIVE',
      terminal: false,
      reasons: ['TIMING_PENDING'],
    });
    const mk = full(
      new Market().traded(bar(m0, '1.3', '1.3', '1.3', '1.3', '1'), [trade('ref', S + 900, '1.3')]),
      '1.3',
    );
    const a = solve(mk, { ...base, now: after(10 * M), cmcPrice: new D('1') });
    expect(a.flags).toContain('PRICE_DEVIATION_FROM_CMC');
    expect(a.status.status).toBe('FINAL');
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

  it('the CMC price only checks identity (25 %, a review flag), never part of a return', () => {
    expect(deviatesFromCmc(new D('0.1435'), new D('0.142987979'))).toBe(false);
    expect(deviatesFromCmc(new D('1.26'), new D('1'))).toBe(true);
    expect(deviatesFromCmc(new D('0.75'), new D('1'))).toBe(false);
  });
});

describe('Spot / Futures at the signal and the eligibility class', () => {
  it('Spot: a series spanning the start shows availability; NO needs LBank’s own answer', () => {
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

  it('Futures listing evidence: snapshots before (CMC by id) and after (LBank list) must agree', () => {
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
    // Recorded: CMC maps the MON perpetual to MoneyByte (5066); a same-ticker contract is not proof.
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

import { describe, expect, it } from 'vitest';

import { parseSpotPrices } from './kline.js';
import {
  COVERAGE_DIFF_VISIBLE_MS,
  coverageTimes,
  futuresEvidence,
  futuresThrough,
} from './observation-freshness.js';

describe('Futures "through" keeps each method’s own time base', () => {
  it('observed-quote rows: our response receipt; old-method rows: LBank’s snapshot time; never converted', () => {
    const at = '2026-11-27T11:51:00.434Z';
    expect(futuresThrough('lbank-futures-quote-1', at)).toEqual({
      basis: 'OUR_RESPONSE_RECEIVED',
      observedThrough: at,
      lbankSnapshotThrough: null,
    });
    const snap = '2026-11-27T11:50:57.000Z';
    expect(futuresThrough('lbank-futures-sampled-1', snap)).toEqual({
      basis: 'LBANK_SNAPSHOT_TIME',
      observedThrough: null,
      lbankSnapshotThrough: snap, // the stored value, unchanged
    });
  });
});

describe('coverage difference between venues', () => {
  const spot = '2026-11-27T11:00:00.000Z';
  const fut = (ms: number) => new Date(Date.parse(spot) + ms).toISOString();
  const c = (futuresThrough: string | null, spotDataThrough: string | null = spot) =>
    coverageTimes({
      spotDataThrough,
      spotLastFetchAt: null,
      futuresThrough,
      futuresBasis: 'OUR_RESPONSE_RECEIVED',
    });
  it('is marked only beyond one minute either way (a display cue, no value depends on it)', () => {
    expect(c(fut(COVERAGE_DIFF_VISIBLE_MS))).toMatchObject({
      differenceMs: 60_000,
      differs: false,
    });
    expect(c(fut(60_001))).toMatchObject({ differenceMs: 60_001, differs: true });
    expect(c(fut(-60_001))).toMatchObject({ differenceMs: -60_001, differs: true });
    expect(c(fut(63 * 60_000 + 434))).toMatchObject({ differs: true });
  });
  it('unknown when either venue has no data yet', () => {
    expect(c(null)).toMatchObject({ differenceMs: null, differs: false });
    expect(c(fut(5), null)).toMatchObject({ differenceMs: null, differs: false });
  });
});

describe('Futures evidence classes', () => {
  const base = {
    rulesVersion: 'lbank-futures-quote-1',
    mapping: 'OK',
    contract: 'CFGUSDT' as string | null,
    status: 'ACTIVE',
    entrySource: null as string | null,
    startMs: Date.parse('2026-11-27T11:07:06.040Z'),
    firstPollMs: Date.parse('2026-11-27T08:25:01.173Z'),
    legacyFirst: null as { retained: boolean } | null,
  };
  const cls = (o: Partial<typeof base>) => futuresEvidence({ ...base, ...o });
  it('new method: only a quote from the publication request (or its retry) is an immediate entry', () => {
    expect(cls({ entrySource: 'PUBLICATION' })).toEqual({
      evidenceClass: 'IMMEDIATE_QUOTE',
      immediateEntry: true,
    });
    expect(cls({ entrySource: 'RETRY' }).evidenceClass).toBe('IMMEDIATE_QUOTE');
    expect(cls({ entrySource: 'TICK' })).toEqual({
      evidenceClass: 'TICK_QUOTE',
      immediateEntry: false,
    });
    expect(cls({ status: 'PENDING' }).evidenceClass).toBe('QUOTE_PENDING');
    expect(cls({ status: 'NO_REFERENCE' }).evidenceClass).toBe('NO_QUOTE');
    expect(cls({ mapping: 'NONE', contract: null }).evidenceClass).toBe('NO_CONTRACT');
  });
  it('old method: before collection, first response kept or lost — never an immediate entry', () => {
    const old = { rulesVersion: 'lbank-futures-sampled-1' };
    expect(
      cls({ ...old, startMs: Date.parse('2026-11-27T08:07:05.052Z') }), // before the first request
    ).toEqual({ evidenceClass: 'LEGACY_BEFORE_COLLECTION', immediateEntry: false });
    expect(cls({ ...old, legacyFirst: { retained: true } }).evidenceClass).toBe(
      'LEGACY_FIRST_RESPONSE_RETAINED',
    );
    expect(cls({ ...old, legacyFirst: { retained: false } }).evidenceClass).toBe(
      'LEGACY_FIRST_RESPONSE_LOST',
    );
    expect(cls({ ...old, legacyFirst: null }).evidenceClass).toBe('LEGACY_UNRESOLVED');
    expect(cls({ ...old, mapping: 'AMBIGUOUS', contract: null }).evidenceClass).toBe('NO_CONTRACT');
    // An old-method row never becomes immediate, whatever its later post-fix quote.
    expect(cls({ ...old, entrySource: 'PUBLICATION', legacyFirst: { retained: true } })).toEqual({
      evidenceClass: 'LEGACY_FIRST_RESPONSE_RETAINED',
      immediateEntry: false,
    });
  });
});

describe('LBank Spot all-pairs price response', () => {
  it('keeps LBank’s digits, lower-cases symbols, counts invalid rows; ts is the response time', () => {
    const r = parseSpotPrices(
      '{"result":true,"data":[{"symbol":"PONS_USDT","price":"0.108400"},{"symbol":"x_usdt","price":"0"},{"symbol":"y_usdt"}],"error_code":0,"ts":1795785551577}',
    );
    expect(r).toMatchObject({
      kind: 'ok',
      rows: [{ symbol: 'pons_usdt', price: '0.1084' }],
      invalid: 2,
      serverMs: 1795785551577,
    });
  });
  it('an error code or no usable row is an error, never an empty success', () => {
    expect(parseSpotPrices('{"result":"false","error_code":10008,"msg":"x"}').kind).toBe('error');
    expect(parseSpotPrices('{"result":true,"data":[],"error_code":0}').kind).toBe('error');
    expect(parseSpotPrices('not json').kind).toBe('error');
  });
});

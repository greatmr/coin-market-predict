import { describe, expect, it } from 'vitest';

import {
  lbankResponseStatus,
  parseFuturesResponses,
  parseKlineResponse,
  parsePairsResponse,
} from './kline.js';

/** Response recorded from https://api.lbkex.com/v2/kline.do (btc_usdt, minute1, size=5) on 2026-11-24. */
const RECORDED =
  '{"msg":"Success","result":"true","data":[[1795524120,60337,60447.6,60335.2,60419.72,2.68865],[1795524180,60419.72,60460.3,60406.38,60431.25,5.66709],[1795524240,60431.25,60646.3,60422.07,60545.8,11.12025],[1795524300,60545.8,60609.51,60463.73,60463.73,1.16869],[1795524360,60463.73,60470.58,60413.05,60415.83,1.74307]],"error_code":0,"ts":1795527748467}';

describe('LBank kline response', () => {
  it('keeps the exact source digits and the server time; every closed bar is kept in order', () => {
    const r = parseKlineResponse(RECORDED);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.serverTsMs).toBe(1795527748467);
    expect(r.bars.map((b) => new Date(b.openMs).toISOString())).toEqual([
      '2026-11-24T12:42:00.000Z',
      '2026-11-24T12:43:00.000Z',
      '2026-11-24T12:44:00.000Z',
      '2026-11-24T12:45:00.000Z',
      '2026-11-24T12:46:00.000Z',
    ]);
    expect(r.bars[1]!.high.toFixed()).toBe('60460.3');
    expect(r.bars[0]!.volume.toFixed()).toBe('2.68865');
    expect(r.closed).toHaveLength(5);
    // OPEN of each bar is the previous bar's CLOSE.
    for (let i = 1; i < r.bars.length; i++)
      expect(r.bars[i]!.open.eq(r.bars[i - 1]!.close)).toBe(true);
  });

  it('drops the minute still in progress (judged by the server time, with a 5 s margin)', () => {
    const body = (ts: number) =>
      `{"msg":"Success","result":"true","data":[[1795528320,0.0974,0.0974,0.0972,0.0973,5651.91],[1795528380,0.0973,0.0973,0.0973,0.0973,0]],"error_code":0,"ts":${ts}}`;
    // 13:53:01.154 — the 13:52 bar closed 1.15 s ago: within the margin, not yet trusted.
    const early = parseKlineResponse(body(1795528381154));
    expect(early.kind === 'ok' && early.closed.length).toBe(0);
    const later = parseKlineResponse(body(1795528385001));
    expect(later.kind === 'ok' && later.closed.map((b) => b.openMs / 1000)).toEqual([1795528320]);
  });

  it('LBank error 10008 (unknown or delisted pair) is "unsupported", other codes are errors', () => {
    const unsupported = parseKlineResponse(
      '{"result":"false","msg":"currency pair nonsupport","error_code":10008,"ts":1795528036086}',
    );
    expect(unsupported).toMatchObject({
      kind: 'unsupported',
      code: 10008,
      message: 'currency pair nonsupport',
    });
    expect(
      parseKlineResponse('{"result":"false","msg":"Illegal parameter","error_code":10003,"ts":1}'),
    ).toMatchObject({
      kind: 'error',
      code: 10003,
    });
    expect(parseKlineResponse('<html>busy</html>')).toMatchObject({ kind: 'error', code: null });
  });

  it('drops invalid rows and duplicates and sorts unordered rows (all reported)', () => {
    const r = parseKlineResponse(
      '{"result":"true","data":[[120,1,2,0.5,1.5,3],[60,1,2,0.5,1,3],[60,1,2,0.5,1,3],[90,1,2,0.5,1,3],[180,1,0.4,0.5,1,3],[240,0,1,1,1,1],[300,"x",1,1,1,1]],"error_code":0,"ts":999999999999}',
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.bars.map((b) => b.openMs / 1000)).toEqual([60, 120]);
    expect(r.duplicates).toBe(1);
    expect(r.unordered).toBe(true);
    expect(r.invalid.map((x) => x.reason)).toEqual([
      'time not a whole UTC minute',
      'inconsistent high / low / close',
      'non-positive price',
      'non-numeric value',
    ]);
  });

  it('maps rate limiting and internal errors for the HTTP client', () => {
    expect(lbankResponseStatus(200, '{"error_code":10004,"msg":"Request too frequent"}')).toBe(429);
    expect(lbankResponseStatus(200, '{"error_code":10000}')).toBe(503);
    expect(lbankResponseStatus(200, '{"error_code":10008}')).toBe(200);
    expect(lbankResponseStatus(502, 'bad gateway')).toBe(502);
  });
});

describe('LBank markets lists', () => {
  it('Spot pairs: lower-case, unique, sorted', () => {
    expect(
      parsePairsResponse(
        '{"result":"true","data":["eth_usdt","BTC_USDT","btc_usdt"],"error_code":0,"ts":1}',
      ),
    ).toEqual({
      kind: 'ok',
      symbols: ['btc_usdt', 'eth_usdt'],
      serverTsMs: 1,
    });
    expect(parsePairsResponse('{"result":"true","data":[],"error_code":0}')).toMatchObject({
      kind: 'error',
    });
  });

  it('Futures contracts joined with their 24 h volume (recorded field names)', () => {
    const ins =
      '{"data":[{"symbol":"BTCUSDT","baseCurrency":"BTC","priceCurrency":"USDT","needSuspend":0},{"symbol":"SOXLUSDT","baseCurrency":"SOXL","priceCurrency":"USDT"}],"error_code":0,"msg":"Success","result":"true","success":true}';
    const md =
      '{"data":[{"symbol":"BTCUSDT","volume":"3463181.7","instrumentStatus":"2"}],"error_code":0,"msg":"Success","result":"true"}';
    const r = parseFuturesResponses(ins, md);
    expect(r).toEqual({
      kind: 'ok',
      contracts: [
        { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', volume24h: '3463181.7' },
        { symbol: 'SOXLUSDT', base: 'SOXL', quote: 'USDT', volume24h: null },
      ],
    });
  });
});

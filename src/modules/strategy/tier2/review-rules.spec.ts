import { describe, expect, it } from 'vitest';

import { ReviewSchema, blockingErrors, validateReview } from './review-rules.js';

describe('Tier 2 review record and trade plan (p.24–27)', () => {
  const base = { cmcId: 7, batchId: '8f0d3c2e-7a35-4c62-9a4b-0c1d2e3f4a5b', reviewer: 'trader' };
  const ctx = {
    symbol: 'ABC',
    verifiedLbankPairs: ['ABC/USDT'],
    listedLbankPairs: ['ABC/USDT', 'ABC/BTC'],
  };
  const plan = {
    entryPrice: '2.00',
    entryTime: '2026-11-05T00:00:00Z',
    stopPrice: '1.72',
    targets: [
      { price: '2.3', allocationPct: '50' },
      { price: '2.6', allocationPct: '30' },
      { price: '3', allocationPct: '20' },
    ],
    notes: 'manual plan',
  };
  const v = (o: Record<string, unknown>) =>
    validateReview(ReviewSchema.parse({ ...base, ...o }), ctx);

  it('PLAN_READY with every field and valid ordering is COMPLETE with derived stop % and 7 × 24 h deadline', () => {
    const r = v({
      finalDecision: 'PLAN_READY',
      lbankPair: 'ABC/USDT',
      eventDay: 'SECOND',
      candleState: 'PRE_MOVE',
      plan,
    });
    expect(r.errors).toEqual([]);
    expect(r.planStatus).toBe('COMPLETE');
    expect(r.plan).toMatchObject({ stopPct: '14', deadline: '2026-11-12T00:00:00.000Z' });
  });
  it('missing plan fields or wrong ordering keep the plan INCOMPLETE', () => {
    expect(
      v({
        finalDecision: 'PLAN_READY',
        lbankPair: 'ABC/USDT',
        plan: { ...plan, notes: undefined, targets: plan.targets.slice(0, 2) },
      }).errors,
    ).toEqual(
      expect.arrayContaining([
        'plan: TP3 price is required (> 0)',
        'plan: plan notes are required',
      ]),
    );
    const order = v({
      finalDecision: 'PLAN_READY',
      lbankPair: 'ABC/USDT',
      plan: {
        ...plan,
        stopPrice: '2.10',
        targets: [
          { price: '1.9', allocationPct: '50' },
          { price: '2.6', allocationPct: '30' },
          { price: '2.5', allocationPct: '20' },
        ],
      },
    });
    expect(order.planStatus).toBe('INCOMPLETE');
    expect(order.errors).toEqual(
      expect.arrayContaining([
        'plan: stop must be below entry (long spot plan)',
        'plan: TP1 must be above entry',
        'plan: TP3 must be above TP2',
      ]),
    );
    expect(
      v({
        finalDecision: 'PLAN_READY',
        lbankPair: 'ABC/USDT',
        plan: {
          ...plan,
          targets: [
            { price: '2.3', allocationPct: '60' },
            { price: '2.6', allocationPct: '30' },
            { price: '3', allocationPct: '20' },
          ],
        },
      }).errors.join(' '),
    ).toMatch(/110 %/);
    expect(v({ finalDecision: 'PLAN_READY', lbankPair: 'ABC/BTC', plan }).errors.join(' ')).toMatch(
      /not verified tradable/,
    );
    expect(v({ finalDecision: 'PLAN_READY', plan }).errors.join(' ')).toMatch(
      /confirm the actual LBank Spot pair/,
    );
  });
  it('a later or uncertain event needs an explicit disposition; uncertain judgments are recorded, not blocked', () => {
    expect(
      v({
        finalDecision: 'PLAN_READY',
        lbankPair: 'ABC/USDT',
        eventDay: 'LATER',
        plan,
      }).errors.join(' '),
    ).toMatch(/explicit disposition/);
    const ok = v({
      finalDecision: 'PLAN_READY',
      lbankPair: 'ABC/USDT',
      eventDay: 'LATER',
      rationale: 'accepting a third-day entry: volume still building',
      rangeLow: 'UNCERTAIN',
      plan,
    });
    expect(ok.planStatus).toBe('COMPLETE');
    expect(ok.warnings.join(' ')).toMatch(/range-low judgment marked UNCERTAIN/);
  });
  it('NO_TRADE needs a rationale; a proxy chart needs a reason and a timezone; ticker look-alikes warn', () => {
    expect(blockingErrors(v({ finalDecision: 'NO_TRADE' }))).toEqual([
      'NO_TRADE needs a rationale',
    ]);
    expect(blockingErrors(v({ chartExchange: 'Binance', chartUrl: 'https://x.test/c' }))).toEqual([
      "record the chart's daily candle-close timezone with the chart URL",
      'a non-LBank chart is a proxy: record the reason',
    ]);
    expect(v({ chartSymbol: 'XYZUSDT' }).warnings.join(' ')).toMatch(/not a ticker match/);
    expect(() => ReviewSchema.parse({ ...base, chartUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => ReviewSchema.parse({ ...base, finalDecision: 'BUY' })).toThrow();
  });
  it('records the time exit: an exit after the deadline is flagged', () => {
    const r = v({
      finalDecision: 'PLAN_READY',
      lbankPair: 'ABC/USDT',
      plan: {
        ...plan,
        execution: {
          exitTime: '2026-11-13T00:00:00Z',
          exitReason: 'time exit',
          tpFilled: [true, false, false],
        },
      },
    });
    expect(r.warnings.join(' ')).toMatch(/after the 7 × 24 h time exit/);
  });
});

import { describe, expect, it } from 'vitest';

import { D, type DValue } from '../../common/utils/decimal.js';

import {
  type DailyHighInput,
  type EventWindow,
  type OutcomeHigh,
  type TriggerCandidate,
  type TriggerContext,
  classifyHigh,
  dayComplete,
  evaluateOutcome,
  eventWindow,
  peakReturnPct,
  validateTrigger,
} from './forward-rules.js';
import { FORWARD_REASON as R } from './forward.constants.js';

const t = (s: string) => new Date(s);
const d = (x: string | number) => new D(x);
const str = (x: DValue | null) => (x === null ? null : x.toFixed());

/** PDF p.11: a signal at 10 Nov 14:00 UTC. */
const W = eventWindow(t('2026-11-10T14:00:00.000Z'));
const PRICE = d('10');
const AFTER = t('2026-11-18T00:30:00.000Z');

function high(
  w: EventWindow,
  date: string,
  value: string | null,
  timeHigh?: string | null,
  extra: Partial<DailyHighInput> = {},
) {
  return classifyHigh(w, {
    dateUtc: date,
    periodStart: null,
    periodEnd: null,
    high: value === null ? null : d(value),
    timeHigh: timeHigh ? t(timeHigh) : null,
    invalidReasons: [],
    ...extra,
  });
}

/** One High per date of W; day 0 gets an explicit row, the other days a flat 11 unless given. */
function week(day0: OutcomeHigh | null, overrides: Record<string, OutcomeHigh | null> = {}) {
  const rows: OutcomeHigh[] = [];
  for (const date of W.dates) {
    if (date === W.detectedUtcDate) {
      if (day0) rows.push(day0);
      continue;
    }
    if (date in overrides) {
      const o = overrides[date];
      if (o) rows.push(o);
    } else rows.push(high(W, date, '11', `${date}T12:00:00.000Z`));
  }
  return rows;
}

const outcome = (highs: OutcomeHigh[], now = AFTER, w = W) =>
  evaluateOutcome({ window: w, price: PRICE, highs, now });

describe('event window (p.6)', () => {
  it('10 Nov 14:00 → deadline 17 Nov 14:00, evaluation_end 17 Nov 23:59:59.999, 178 h', () => {
    expect(W.detectedUtcDate).toBe('2026-11-10');
    expect(W.deadline168h.toISOString()).toBe('2026-11-17T14:00:00.000Z');
    expect(W.evaluationEnd.toISOString()).toBe('2026-11-17T23:59:59.999Z');
    expect(str(W.effectiveHorizonHours)).toBe('178');
    expect(W.dates).toEqual([
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
    ]);
  });

  it('the extension is up to almost 24 h: midnight gives 192 h, the last millisecond 168 h + 1 ms', () => {
    const midnight = eventWindow(t('2026-11-10T00:00:00.000Z'));
    expect(midnight.deadline168h.toISOString()).toBe('2026-11-17T00:00:00.000Z');
    expect(midnight.evaluationEnd.toISOString()).toBe('2026-11-17T23:59:59.999Z');
    expect(str(midnight.effectiveHorizonHours)).toBe('192');
    const late = eventWindow(t('2026-11-10T23:59:59.999Z'));
    expect(late.evaluationEnd.toISOString()).toBe('2026-11-17T23:59:59.999Z');
    // 1 ms is a repeating decimal in hours: compare in milliseconds.
    expect(late.effectiveHorizonHours.times(3_600_000).toDecimalPlaces(9).toFixed()).toBe(
      String(168 * 3_600_000 + 1),
    );
    expect(late.dates).toHaveLength(8);
  });

  it('keys on the UTC date, never the display timezone (p.4)', () => {
    // 22:30 UTC is already 11 Nov in Asia/Tehran; the event still belongs to 10 Nov.
    expect(eventWindow(t('2026-11-10T22:30:00.000Z')).detectedUtcDate).toBe('2026-11-10');
  });

  it('a day is complete only after its last millisecond', () => {
    expect(dayComplete('2026-11-17', t('2026-11-17T23:59:59.999Z'))).toBe(false);
    expect(dayComplete('2026-11-17', t('2026-11-18T00:00:00.000Z'))).toBe(true);
  });
});

describe('daily High eligibility (p.5, p.6)', () => {
  it('excludes a pre-signal High on the signal day (10 Nov 09:00)', () => {
    const h = high(W, '2026-11-10', '20', '2026-11-10T09:00:00.000Z');
    expect([h.eligibility, h.reason]).toEqual(['DAY0_UNPROVEN', 'time_high_before_detection']);
  });

  it('counts the signal-day High when its documented time is at or after detection', () => {
    expect(high(W, '2026-11-10', '12', '2026-11-10T14:00:00.000Z').eligibility).toBe(
      'DAY0_POST_SIGNAL',
    );
    expect(high(W, '2026-11-10', '12', '2026-11-10T21:13:00.000Z').eligibility).toBe(
      'DAY0_POST_SIGNAL',
    );
    expect(high(W, '2026-11-10', '12', '2026-11-10T13:59:00.000Z').eligibility).toBe(
      'DAY0_UNPROVEN',
    );
    const unknown = high(W, '2026-11-10', '12', null);
    expect([unknown.eligibility, unknown.reason]).toEqual(['DAY0_UNPROVEN', 'time_high_unknown']);
  });

  it('a signal exactly at midnight makes day 0 a fully covered day', () => {
    const w = eventWindow(t('2026-11-10T00:00:00.000Z'));
    expect(high(w, '2026-11-10', '12', '2026-11-10T00:00:00.000Z').eligibility).toBe('FULL_DAY');
    expect(high(w, '2026-11-10', '12', null).eligibility).toBe('FULL_DAY');
  });

  it('includes the final day (17 Nov 20:00) and excludes 18 Nov and the day before detection', () => {
    expect(high(W, '2026-11-17', '15', '2026-11-17T20:00:00.000Z').eligibility).toBe('FULL_DAY');
    expect(high(W, '2026-11-18', '99', '2026-11-18T00:00:00.000Z')).toMatchObject({
      eligibility: 'INVALID',
      reason: 'outside_window',
    });
    expect(high(W, '2026-11-09', '99').reason).toBe('outside_window');
  });

  it('never substitutes anything for a missing High and rejects unusable values', () => {
    expect(high(W, '2026-11-12', null).reason).toBe('high_missing');
    expect(high(W, '2026-11-12', '0').reason).toBe('high_not_positive');
    expect(high(W, '2026-11-12', '-3').reason).toBe('high_not_positive');
    expect(high(W, '2026-11-12', 'NaN').reason).toBe('high_not_finite');
    expect(high(W, '2026-11-12', 'Infinity').reason).toBe('high_not_finite');
  });

  it('accepts only one-UTC-day USD candles of the same series (source mismatch → INVALID)', () => {
    expect(high(W, '2026-11-12', '12', null, { invalidReasons: ['quote_not_usd'] }).reason).toBe(
      'quote_not_usd',
    );
    expect(
      high(W, '2026-11-12', '12', null, {
        periodStart: t('2026-11-12T04:00:00.000Z'),
      }).reason,
    ).toBe('period_not_one_utc_day');
    // A VMC-only problem (cap 0) does not make the High unusable.
    expect(
      high(W, '2026-11-12', '12', null, { invalidReasons: ['market_cap_zero'] }).eligibility,
    ).toBe('FULL_DAY');
  });

  it('drops a documented time outside its own candle instead of trusting it', () => {
    const h = high(W, '2026-11-12', '12', '2026-11-13T01:00:00.000Z');
    expect([h.eligibility, h.timeHigh, h.reason]).toEqual([
      'FULL_DAY',
      null,
      'time_high_outside_period',
    ]);
    expect(high(W, '2026-11-10', '12', '2026-11-11T01:00:00.000Z').eligibility).toBe(
      'DAY0_UNPROVEN',
    );
  });
});

describe('outcome (p.6–8, acceptance p.11)', () => {
  it('price $10 and an eligible future maximum High $15 → peak_return_pct 50 %', () => {
    const o = outcome(
      week(high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), {
        '2026-11-13': high(W, '2026-11-13', '15', '2026-11-13T06:00:00.000Z'),
      }),
    );
    expect(o).toMatchObject({
      status: 'FINAL',
      coverageStatus: 'COMPLETE',
      peakKind: 'EXACT',
      peakDate: '2026-11-13',
      peakTimePrecision: 'SOURCE_TIME',
      extensionPeakFlag: 'FALSE',
      day0: 'EXACT',
      coveredDays: 8,
      expectedDays: 8,
      reasons: [],
    });
    expect(str(o.peakHigh)).toBe('15');
    expect(str(o.peakReturnPct)).toBe('50');
    expect(o.peakAt!.toISOString()).toBe('2026-11-13T06:00:00.000Z');
  });

  it('a same-day pre-signal High of $20 never produces 100 %; a later $15 leaves day 0 incomplete', () => {
    const preSignal = high(W, '2026-11-10', '20', '2026-11-10T09:00:00.000Z');
    const o = outcome(
      week(preSignal, { '2026-11-13': high(W, '2026-11-13', '15', '2026-11-13T06:00:00.000Z') }),
    );
    expect(o).toMatchObject({
      status: 'INCOMPLETE',
      coverageStatus: 'INCOMPLETE',
      peakKind: 'LOWER_BOUND',
      day0: 'UNRESOLVED',
      coveredDays: 7,
      reasons: [R.incompleteDay0],
    });
    expect(str(o.peakHigh)).toBe('15');
    expect(str(o.peakReturnPct)).toBe('50');
    expect(str(o.peakReturnPct)).not.toBe('100');
  });

  it('a later High of $21 settles the peak exactly without day-0 intraday data (110 %)', () => {
    const preSignal = high(W, '2026-11-10', '20', '2026-11-10T09:00:00.000Z');
    const o = outcome(
      week(preSignal, { '2026-11-14': high(W, '2026-11-14', '21', '2026-11-14T03:00:00.000Z') }),
    );
    expect(o).toMatchObject({
      status: 'FINAL',
      peakKind: 'EXACT',
      day0: 'SHORTCUT',
      coveredDays: 8,
      reasons: [],
    });
    expect(str(o.peakReturnPct)).toBe('110');
  });

  it('a High on 17 Nov 20:00 is included with extension_peak_flag TRUE', () => {
    const o = outcome(
      week(high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), {
        '2026-11-17': high(W, '2026-11-17', '15', '2026-11-17T20:00:00.000Z'),
      }),
    );
    expect([o.status, o.peakDate, o.extensionPeakFlag]).toEqual(['FINAL', '2026-11-17', 'TRUE']);
    expect(o.peakAt!.toISOString()).toBe('2026-11-17T20:00:00.000Z');
  });

  it('a peak before the deadline on the final day is not in the extension', () => {
    const o = outcome(
      week(high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), {
        '2026-11-17': high(W, '2026-11-17', '15', '2026-11-17T13:59:00.000Z'),
      }),
    );
    expect(o.extensionPeakFlag).toBe('FALSE');
  });

  it('without a peak time, the final day gives UNKNOWN and earlier days FALSE (UTC_DAY precision)', () => {
    const onFinal = outcome(
      week(high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), {
        '2026-11-17': high(W, '2026-11-17', '15', null),
      }),
    );
    expect([onFinal.peakTimePrecision, onFinal.extensionPeakFlag, onFinal.peakAt]).toEqual([
      'UTC_DAY',
      'UNKNOWN',
      null,
    ]);
    expect(onFinal.peakPeriodStart!.toISOString()).toBe('2026-11-17T00:00:00.000Z');
    const earlier = outcome(
      week(high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), {
        '2026-11-16': high(W, '2026-11-16', '15', null),
      }),
    );
    expect([earlier.peakTimePrecision, earlier.extensionPeakFlag]).toEqual(['UTC_DAY', 'FALSE']);
  });

  it('a tie with the unobserved day-0 part keeps the exact value but cannot prove the extension', () => {
    const preSignal = high(W, '2026-11-10', '20', '2026-11-10T09:00:00.000Z');
    const o = outcome(
      week(preSignal, { '2026-11-17': high(W, '2026-11-17', '20', '2026-11-17T20:00:00.000Z') }),
    );
    expect(o).toMatchObject({
      status: 'FINAL',
      peakKind: 'EXACT',
      day0: 'SHORTCUT',
      extensionPeakFlag: 'UNKNOWN',
      reasons: [R.peakTieUnobservedDay0],
    });
    // 100 % here comes from a post-signal High of $20 on 17 Nov, not from the pre-signal one.
    expect(str(o.peakReturnPct)).toBe('100');
  });

  it('ties between days go to the earliest High', () => {
    const o = outcome(
      week(high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), {
        '2026-11-12': high(W, '2026-11-12', '15', '2026-11-12T10:00:00.000Z'),
        '2026-11-15': high(W, '2026-11-15', '15', '2026-11-15T01:00:00.000Z'),
      }),
    );
    expect(o.peakDate).toBe('2026-11-12');
  });

  it('missing and invalid days make the event INCOMPLETE with reasons and a lower bound', () => {
    const o = outcome(
      week(high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), {
        '2026-11-13': null,
        '2026-11-14': high(W, '2026-11-14', '30', null, { invalidReasons: ['quote_not_usd'] }),
      }),
    );
    expect(o).toMatchObject({
      status: 'INCOMPLETE',
      peakKind: 'LOWER_BOUND',
      missingDates: ['2026-11-13'],
      invalidDates: ['2026-11-14:quote_not_usd'],
      reasons: [`${R.highMissing}:2026-11-13`, `${R.highInvalid}:2026-11-14:quote_not_usd`],
    });
    // The invalid row's 30 is never used.
    expect(str(o.peakHigh)).toBe('12');
  });

  it('a revised High is reprocessed into a different outcome', () => {
    const base = week(high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), {
      '2026-11-13': high(W, '2026-11-13', '15', '2026-11-13T06:00:00.000Z'),
    });
    const revised = base.map((h) =>
      h.dateUtc === '2026-11-13' ? high(W, '2026-11-13', '16', '2026-11-13T07:00:00.000Z') : h,
    );
    expect(str(outcome(base).peakReturnPct)).toBe('50');
    expect(str(outcome(revised).peakReturnPct)).toBe('60');
  });
});

describe('status lifecycle (p.7): FINAL only after the last included day is complete', () => {
  const day0 = high(W, '2026-11-10', '12', '2026-11-10T15:00:00.000Z');
  const all = week(day0);

  it('OPEN until the signal day closes', () => {
    const o = outcome([], t('2026-11-10T23:00:00.000Z'));
    expect([o.status, o.peakKind, o.day0, o.completedDays]).toEqual(['OPEN', 'NONE', 'PENDING', 0]);
  });

  it('TRACKING with a provisional running maximum, even after a pump', () => {
    const pump = [day0, high(W, '2026-11-11', '30', '2026-11-11T02:00:00.000Z')];
    const o = outcome(pump, t('2026-11-12T00:30:00.000Z'));
    expect([o.status, o.coverageStatus, o.peakKind]).toEqual([
      'TRACKING',
      'PROVISIONAL',
      'LOWER_BOUND',
    ]);
    expect(str(o.peakReturnPct)).toBe('200');
  });

  it('AWAITING_FINAL_DAY after 168 h while the final day is still open', () => {
    const o = outcome(all.slice(0, 7), t('2026-11-17T15:00:00.000Z'));
    expect([o.status, o.coverageStatus, o.reasons]).toEqual([
      'AWAITING_FINAL_DAY',
      'PROVISIONAL',
      [],
    ]);
  });

  it('seven elapsed dates are not enough: a late final-day High keeps AWAITING_FINAL_DAY', () => {
    const o = outcome(all.slice(0, 7), AFTER);
    expect(o).toMatchObject({
      status: 'AWAITING_FINAL_DAY',
      peakKind: 'LOWER_BOUND',
      reasons: [`${R.highMissing}:2026-11-17`, R.finalDayPending],
    });
  });

  it('FINAL once every included day, the final one too, is covered', () => {
    expect(outcome(all, AFTER).status).toBe('FINAL');
    expect(outcome(all, t('2026-11-17T23:59:59.999Z')).status).toBe('AWAITING_FINAL_DAY');
  });

  it('an unresolved day 0 is provisional while tracking and INCOMPLETE_DAY0 at the end', () => {
    const pre = high(W, '2026-11-10', '20', '2026-11-10T09:00:00.000Z');
    expect(outcome([pre], t('2026-11-11T01:00:00.000Z')).reasons).toEqual([R.day0Unresolved]);
    expect(outcome(week(pre), AFTER).reasons).toEqual([R.incompleteDay0]);
  });
});

describe('trigger validation (p.3, p.10, acceptance p.11)', () => {
  const ok: TriggerCandidate = {
    cmcId: 123,
    stars: 1,
    inQueue: true,
    eligibilityStatus: 'ELIGIBLE',
    lbankStatus: 'VERIFIED',
    price: d('10'),
    currentStatus: 'OK',
    sourceUpdatedAt: t('2026-11-10T10:06:10.000Z'),
    observedAt: t('2026-11-10T10:07:30.000Z'),
    identityUnique: true,
  };
  const ctx: TriggerContext = {
    queueStatus: 'PUBLISHED',
    batchStatus: 'COMPLETE',
    now: t('2026-11-10T10:20:00.000Z'),
    maxBatchAgeMs: 120 * 60_000,
    maxQuoteAgeMs: 120 * 60_000,
  };

  it('an eligible 1-star queue row qualifies without any human step', () => {
    expect(validateTrigger(ok, ctx)).toEqual([]);
    expect(validateTrigger({ ...ok, stars: 3 }, ctx)).toEqual([]);
  });

  it('a 0-star row and an asset outside the Review Queue open no event', () => {
    expect(validateTrigger({ ...ok, stars: 0, inQueue: false }, ctx)).toEqual([
      R.notInQueue,
      `${R.starsOutOfRange}:0`,
    ]);
    expect(
      validateTrigger({ ...ok, inQueue: false, eligibilityStatus: 'NEEDS_REVIEW' }, ctx),
    ).toEqual([R.notInQueue, `${R.notEligible}:NEEDS_REVIEW`]);
  });

  it('a stale quote opens no event (scanner status or quote age)', () => {
    expect(validateTrigger({ ...ok, currentStatus: 'STALE' }, ctx)).toEqual([R.quoteStale]);
    expect(validateTrigger({ ...ok, sourceUpdatedAt: t('2026-11-10T08:00:00.000Z') }, ctx)).toEqual(
      [R.quoteStale],
    );
    expect(validateTrigger({ ...ok, currentStatus: 'TIMESTAMP_UNVERIFIED' }, ctx)).toEqual([
      `${R.quoteNotOk}:TIMESTAMP_UNVERIFIED`,
    ]);
  });

  it('a missing or ambiguous CMC id opens no event', () => {
    expect(validateTrigger({ ...ok, cmcId: null }, ctx)).toEqual([R.cmcIdMissing]);
    expect(validateTrigger({ ...ok, cmcId: 0 }, ctx)).toEqual([R.cmcIdMissing]);
    expect(validateTrigger({ ...ok, identityUnique: false }, ctx)).toEqual([R.assetIdAmbiguous]);
  });

  it('rejects zero, negative, non-finite and missing prices', () => {
    expect(validateTrigger({ ...ok, price: null }, ctx)).toEqual([R.priceMissing]);
    expect(validateTrigger({ ...ok, price: d(0) }, ctx)).toEqual([R.priceNotPositive]);
    expect(validateTrigger({ ...ok, price: d(-1) }, ctx)).toEqual([R.priceNotPositive]);
    expect(validateTrigger({ ...ok, price: d('NaN') }, ctx)).toEqual([R.priceNotFinite]);
    expect(validateTrigger({ ...ok, price: d('Infinity') }, ctx)).toEqual([R.priceNotFinite]);
  });

  it('an incomplete scanner batch or a withheld queue opens no event', () => {
    expect(
      validateTrigger(ok, {
        ...ctx,
        queueStatus: 'WITHHELD_INCOMPLETE_BATCH',
        batchStatus: 'INCOMPLETE',
      }),
    ).toEqual([
      `${R.queueNotPublished}:WITHHELD_INCOMPLETE_BATCH`,
      `${R.batchNotComplete}:INCOMPLETE`,
    ]);
  });

  it('a replayed old batch is not a live forward test (no backfill)', () => {
    expect(validateTrigger(ok, { ...ctx, now: t('2026-11-10T13:00:00.000Z') })).toEqual([
      R.batchNotCurrent,
    ]);
  });

  it('requires a verified LBank pair and both timestamps', () => {
    expect(validateTrigger({ ...ok, lbankStatus: 'UNKNOWN' }, ctx)).toEqual([
      `${R.lbankNotVerified}:UNKNOWN`,
    ]);
    expect(validateTrigger({ ...ok, sourceUpdatedAt: null }, ctx)).toEqual([R.sourceTimeMissing]);
    expect(validateTrigger({ ...ok, observedAt: null }, ctx)).toEqual([R.observedAtMissing]);
  });
});

describe('peak_return_pct (p.8)', () => {
  it('is unrounded (full source digits, no float step)', () => {
    expect(peakReturnPct(d('15.000000000000000001'), d('10')).toFixed()).toBe(
      '50.00000000000000001',
    );
    expect(peakReturnPct(d('9.5'), d('10')).toFixed()).toBe('-5');
  });
});

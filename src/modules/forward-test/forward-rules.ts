import { DAY_MS, type IsoDate, eachDay, isoDate, parseIsoDate } from '../../common/utils/dates.js';
import { D, type DValue } from '../../common/utils/decimal.js';

import {
  type CoverageStatus,
  type ExtensionFlag,
  type ForwardEventStatus,
  HORIZON_MS,
  type HighEligibility,
  type PeakKind,
  FORWARD_REASON as R,
  type TimePrecision,
} from './forward.constants.js';

/**
 * Forward-test rules (docs/forward-test.md, PDF p.3–8), pure and exact: the event window, trigger
 * validation, how each daily High counts for an event, and an event's outcome and status. No I/O;
 * the PDF's acceptance cases (p.11) are in forward-rules.spec.ts.
 */

// ── Window (p.6) ─────────────────────────────────────────────────────────────────────────────

export interface EventWindow {
  /** The first qualifying scanner observation: the batch's crawl time (the scan's as-of time). */
  detectedAt: Date;
  /** UTC date of detectedAt; part of the event key (never the operator's local date, p.4). */
  detectedUtcDate: IsoDate;
  deadline168h: Date;
  /** 23:59:59.999 UTC of the date containing deadline168h (inclusive). */
  evaluationEnd: Date;
  /** Length of [detectedAt, evaluationEnd] at millisecond resolution, in hours: (168, 192]. */
  effectiveHorizonHours: DValue;
  /** The UTC dates whose Highs are included: detectedUtcDate … date(evaluationEnd) (8 dates). */
  dates: IsoDate[];
}

export function eventWindow(detectedAt: Date): EventWindow {
  const deadline168h = new Date(detectedAt.getTime() + HORIZON_MS);
  const finalDate = isoDate(deadline168h);
  const evaluationEnd = new Date(parseIsoDate(finalDate).getTime() + DAY_MS - 1);
  return {
    detectedAt,
    detectedUtcDate: isoDate(detectedAt),
    deadline168h,
    evaluationEnd,
    effectiveHorizonHours: new D(evaluationEnd.getTime() + 1 - detectedAt.getTime()).div(3_600_000),
    dates: eachDay(isoDate(detectedAt), finalDate),
  };
}

/** A UTC date is complete once its last millisecond has passed. */
export const dayComplete = (date: IsoDate, now: Date): boolean =>
  now.getTime() >= parseIsoDate(date).getTime() + DAY_MS;

// ── Trigger (p.3, p.4, p.10) ─────────────────────────────────────────────────────────────────

/** One published Review Queue row as the trigger sees it (adapter: docs/forward-test.md § 3). */
export interface TriggerCandidate {
  cmcId: number | null;
  stars: number;
  inQueue: boolean;
  eligibilityStatus: string;
  lbankStatus: string;
  /** CMC USD price of the qualifying observation, as stored by the scanner. */
  price: DValue | null;
  currentStatus: string;
  /** Provider update time of the quote. */
  sourceUpdatedAt: Date | null;
  /** Crawl time of the observation (becomes detected_at). */
  observedAt: Date | null;
  /** Exactly one stored CMC identity and one observation of this id in the batch. */
  identityUnique: boolean;
}

export interface TriggerContext {
  queueStatus: string | null;
  batchStatus: string;
  now: Date;
  /** A batch older than this when the trigger runs is a replay, not a live publication. */
  maxBatchAgeMs: number;
  maxQuoteAgeMs: number;
}

/**
 * Reasons why a queue row must not open a priced event; empty when it may. Stars are taken from
 * the scanner as published, never recalculated (p.3). Every failing check is reported.
 */
export function validateTrigger(c: TriggerCandidate, ctx: TriggerContext): string[] {
  const reasons: string[] = [];
  if (ctx.queueStatus !== 'PUBLISHED')
    reasons.push(`${R.queueNotPublished}:${ctx.queueStatus ?? 'NONE'}`);
  if (ctx.batchStatus !== 'COMPLETE') reasons.push(`${R.batchNotComplete}:${ctx.batchStatus}`);
  if (!c.inQueue) reasons.push(R.notInQueue);
  if (c.eligibilityStatus !== 'ELIGIBLE') reasons.push(`${R.notEligible}:${c.eligibilityStatus}`);
  if (!Number.isInteger(c.stars) || c.stars < 1 || c.stars > 3)
    reasons.push(`${R.starsOutOfRange}:${c.stars}`);
  if (c.lbankStatus !== 'VERIFIED') reasons.push(`${R.lbankNotVerified}:${c.lbankStatus}`);
  if (c.cmcId === null || !Number.isSafeInteger(c.cmcId) || c.cmcId <= 0)
    reasons.push(R.cmcIdMissing);
  else if (!c.identityUnique) reasons.push(R.assetIdAmbiguous);
  if (c.price === null) reasons.push(R.priceMissing);
  else if (!c.price.isFinite()) reasons.push(R.priceNotFinite);
  else if (c.price.lte(0)) reasons.push(R.priceNotPositive);
  const quoteAgeMs =
    c.observedAt && c.sourceUpdatedAt ? c.observedAt.getTime() - c.sourceUpdatedAt.getTime() : null;
  if (c.currentStatus === 'STALE' || (quoteAgeMs !== null && quoteAgeMs > ctx.maxQuoteAgeMs))
    reasons.push(R.quoteStale);
  else if (c.currentStatus !== 'OK') reasons.push(`${R.quoteNotOk}:${c.currentStatus}`);
  if (!c.sourceUpdatedAt) reasons.push(R.sourceTimeMissing);
  if (!c.observedAt) reasons.push(R.observedAtMissing);
  else if (ctx.now.getTime() - c.observedAt.getTime() > ctx.maxBatchAgeMs)
    reasons.push(R.batchNotCurrent);
  return reasons;
}

// ── Highs (p.5, p.6) ─────────────────────────────────────────────────────────────────────────

/** One completed UTC day of the same asset's CMC USD daily OHLC, as stored by the crawler. */
export interface DailyHighInput {
  dateUtc: IsoDate;
  periodStart: Date | null;
  periodEnd: Date | null;
  high: DValue | null;
  /** The source's documented time of the High (CMC `timeHigh`), when published. */
  timeHigh: Date | null;
  /** Source-level problems of the daily row (e.g. `quote_not_usd`, `period_not_one_utc_day`). */
  invalidReasons: readonly string[];
}

export interface ClassifiedHigh {
  dateUtc: IsoDate;
  periodStart: Date;
  periodEnd: Date;
  high: DValue | null;
  /** The documented time of the High when it lies inside its period, else null. */
  timeHigh: Date | null;
  eligibility: HighEligibility;
  reason: string | null;
}

/** Row problems that make it unusable as the USD High of one UTC day (VMC-only problems do not). */
const HIGH_BLOCKING_REASONS = new Set(['quote_not_usd', 'period_not_one_utc_day']);

/**
 * How one daily High counts for one event. Close is never a substitute: a row without a usable
 * High is INVALID. The signal day's High covers hours before detection, so it counts only when its
 * documented time is at or after detected_at (p.6); otherwise it is only an upper bound of the
 * unknown post-signal part (DAY0_UNPROVEN).
 */
export function classifyHigh(w: EventWindow, r: DailyHighInput): ClassifiedHigh {
  const dayStart = parseIsoDate(r.dateUtc);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1);
  const periodStart = r.periodStart ?? dayStart;
  const periodEnd = r.periodEnd ?? dayEnd;
  const timeHigh =
    r.timeHigh && r.timeHigh >= periodStart && r.timeHigh <= periodEnd ? r.timeHigh : null;
  const result = (eligibility: HighEligibility, reason: string | null): ClassifiedHigh => ({
    dateUtc: r.dateUtc,
    periodStart,
    periodEnd,
    high: r.high,
    timeHigh,
    eligibility,
    reason,
  });
  if (!w.dates.includes(r.dateUtc)) return result('INVALID', 'outside_window');
  const blocking = r.invalidReasons.find((x) => HIGH_BLOCKING_REASONS.has(x));
  if (blocking) return result('INVALID', blocking);
  if (periodStart.getTime() !== dayStart.getTime() || periodEnd.getTime() !== dayEnd.getTime())
    return result('INVALID', 'period_not_one_utc_day');
  if (r.high === null) return result('INVALID', 'high_missing');
  if (!r.high.isFinite()) return result('INVALID', 'high_not_finite');
  if (r.high.lte(0)) return result('INVALID', 'high_not_positive');
  const outside = r.timeHigh && !timeHigh ? 'time_high_outside_period' : null;
  if (r.dateUtc !== w.detectedUtcDate || periodStart >= w.detectedAt)
    return result('FULL_DAY', outside);
  if (timeHigh && timeHigh >= w.detectedAt) return result('DAY0_POST_SIGNAL', null);
  return result(
    'DAY0_UNPROVEN',
    outside ?? (r.timeHigh ? 'time_high_before_detection' : 'time_high_unknown'),
  );
}

// ── Outcome and status (p.6–8) ───────────────────────────────────────────────────────────────

export interface OutcomeHigh extends ClassifiedHigh {
  /** forward_high row id (lineage), when stored. */
  id?: number | null;
}

/** PENDING: the signal day is not complete yet; SHORTCUT: resolved by a later High ≥ its full-day High. */
export const DAY0_STATES = ['PENDING', 'EXACT', 'SHORTCUT', 'UNRESOLVED', 'MISSING'] as const;
export type Day0State = (typeof DAY0_STATES)[number];

export interface ForwardOutcome {
  status: ForwardEventStatus;
  coverageStatus: CoverageStatus;
  peakKind: PeakKind;
  peakHigh: DValue | null;
  peakHighId: number | null;
  peakDate: IsoDate | null;
  /** The source's time of the peak High, when known. */
  peakAt: Date | null;
  peakTimePrecision: TimePrecision | null;
  peakPeriodStart: Date | null;
  peakPeriodEnd: Date | null;
  /** 100 × (peak / reference price − 1), unrounded. A lower bound unless peakKind is EXACT. */
  peakReturnPct: DValue | null;
  extensionPeakFlag: ExtensionFlag | null;
  day0: Day0State;
  expectedDays: number;
  completedDays: number;
  coveredDays: number;
  missingDates: IsoDate[];
  /** `<date>:<reason>` */
  invalidDates: string[];
  reasons: string[];
}

/**
 * The outcome of one event at `now` from its current High rows (at most one per date). The maximum
 * counts only eligible Highs; ties go to the earliest. FINAL needs the whole window to have passed
 * and every included day covered, the final day included — never just elapsed dates (p.7).
 */
export function evaluateOutcome(input: {
  window: EventWindow;
  price: DValue;
  highs: readonly OutcomeHigh[];
  now: Date;
}): ForwardOutcome {
  const { window: w, price, now } = input;
  if (!price.isFinite() || price.lte(0)) throw new Error('reference price must be positive');
  const byDate = new Map<IsoDate, OutcomeHigh>();
  for (const h of input.highs)
    if (w.dates.includes(h.dateUtc) && !byDate.has(h.dateUtc)) byDate.set(h.dateUtc, h);

  const completed = w.dates.filter((d) => dayComplete(d, now));
  const finalDate = w.dates[w.dates.length - 1]!;
  const exact: OutcomeHigh[] = [];
  const missingDates: IsoDate[] = [];
  const invalidDates: string[] = [];
  let day0Bound: DValue | null = null;
  for (const d of completed) {
    const h = byDate.get(d);
    if (!h) missingDates.push(d);
    else if (h.eligibility === 'INVALID') invalidDates.push(`${d}:${h.reason ?? 'invalid'}`);
    else if (h.eligibility === 'DAY0_UNPROVEN') day0Bound = h.high;
    else exact.push(h);
  }
  // Dates are in order, so a strict comparison keeps the earliest of equal Highs.
  const best = exact.reduce<OutcomeHigh | null>(
    (m, h) => (m === null || h.high!.gt(m.high!) ? h : m),
    null,
  );

  // The unknown post-signal part of day 0 is at most its full-day High, so a later High at least as
  // large settles the maximum exactly (p.6). On equality the earliest time cannot be known.
  let day0: Day0State;
  let tie = false;
  const day0Row = byDate.get(w.detectedUtcDate);
  if (!completed.includes(w.detectedUtcDate)) day0 = 'PENDING';
  else if (!day0Row || day0Row.eligibility === 'INVALID') day0 = 'MISSING';
  else if (day0Bound === null) day0 = 'EXACT';
  else if (best && best.high!.gte(day0Bound)) {
    day0 = 'SHORTCUT';
    tie = best.high!.eq(day0Bound);
  } else day0 = 'UNRESOLVED';

  const windowClosed = now.getTime() > w.evaluationEnd.getTime();
  const day0Gap = day0 === 'UNRESOLVED';
  const gaps = missingDates.length > 0 || invalidDates.length > 0 || day0Gap;
  const onlyFinalDayLate =
    windowClosed &&
    !day0Gap &&
    invalidDates.length === 0 &&
    missingDates.length === 1 &&
    missingDates[0] === finalDate;
  let status: ForwardEventStatus;
  if (completed.length === 0) status = 'OPEN';
  else if (now.getTime() <= w.deadline168h.getTime()) status = 'TRACKING';
  else if (!windowClosed || onlyFinalDayLate) status = 'AWAITING_FINAL_DAY';
  else status = gaps ? 'INCOMPLETE' : 'FINAL';

  const reasons = [
    ...missingDates.map((d) => `${R.highMissing}:${d}`),
    ...invalidDates.map((x) => `${R.highInvalid}:${x}`),
  ];
  if (day0Gap) reasons.push(windowClosed ? R.incompleteDay0 : R.day0Unresolved);
  if (onlyFinalDayLate) reasons.push(R.finalDayPending);
  if (tie) reasons.push(R.peakTieUnobservedDay0);

  let extensionPeakFlag: ExtensionFlag | null = null;
  if (best) {
    const deadline = w.deadline168h.getTime();
    extensionPeakFlag = best.timeHigh
      ? best.timeHigh.getTime() > deadline
        ? 'TRUE'
        : 'FALSE'
      : best.periodEnd.getTime() <= deadline
        ? 'FALSE'
        : best.periodStart.getTime() > deadline
          ? 'TRUE'
          : 'UNKNOWN';
    // An equal post-signal High on day 0 would be earlier and before the deadline.
    if (tie && extensionPeakFlag === 'TRUE') extensionPeakFlag = 'UNKNOWN';
  }

  return {
    status,
    coverageStatus:
      status === 'FINAL' ? 'COMPLETE' : status === 'INCOMPLETE' ? 'INCOMPLETE' : 'PROVISIONAL',
    peakKind: !best ? 'NONE' : status === 'FINAL' ? 'EXACT' : 'LOWER_BOUND',
    peakHigh: best?.high ?? null,
    peakHighId: best?.id ?? null,
    peakDate: best?.dateUtc ?? null,
    peakAt: best?.timeHigh ?? null,
    peakTimePrecision: best ? (best.timeHigh ? 'SOURCE_TIME' : 'UTC_DAY') : null,
    peakPeriodStart: best?.periodStart ?? null,
    peakPeriodEnd: best?.periodEnd ?? null,
    peakReturnPct: best ? peakReturnPct(best.high!, price) : null,
    extensionPeakFlag,
    day0,
    expectedDays: w.dates.length,
    completedDays: completed.length,
    coveredDays: exact.length + (day0 === 'SHORTCUT' ? 1 : 0),
    missingDates,
    invalidDates,
    reasons,
  };
}

/** peak_return_pct = 100 × (peak_high_usd / snapshot_price_usd − 1), unrounded (p.8). */
export function peakReturnPct(peakHigh: DValue, price: DValue): DValue {
  return peakHigh.div(price).minus(1).times(100);
}

import { D, type DValue } from '../../common/utils/decimal.js';

import {
  ACTIVE_EVENT_STATUSES,
  type ForwardEventStatus,
  type PeakKind,
} from './forward.constants.js';

/**
 * Star-group comparison (PDF p.9), pure and exact. Primary aggregates use only FINAL events (every
 * included period covered, exact peak); everything else is counted, never averaged in. Events of
 * one asset or one day are correlated observations: they are identified, not treated as
 * independent trades.
 */

export interface CohortEvent {
  eventId: string;
  cmcId: number;
  stars: number;
  detectedAt: Date;
  detectedUtcDate: string;
  evaluationEnd: Date;
  status: ForwardEventStatus;
  peakKind: PeakKind | null;
  peakReturnPct: DValue | null;
  effectiveHorizonHours: DValue;
}

export interface Bin {
  label: string;
  count: number;
}

/** Display bins of the final peak return in percent, [min, max): descriptive, not thresholds. */
export const RETURN_BINS: ReadonlyArray<{ label: string; min: number | null; max: number | null }> =
  [
    { label: '< 0 %', min: null, max: 0 },
    { label: '0 – 5 %', min: 0, max: 5 },
    { label: '5 – 10 %', min: 5, max: 10 },
    { label: '10 – 20 %', min: 10, max: 20 },
    { label: '20 – 50 %', min: 20, max: 50 },
    { label: '50 – 100 %', min: 50, max: 100 },
    { label: '≥ 100 %', min: 100, max: null },
  ];

/** Effective horizon bins in hours, (lo, hi]: 168 h + the rest of the deadline's UTC day. */
export const HORIZON_BINS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  168, 172, 176, 180, 184, 188,
].map((lo) => ({ label: `${lo} – ${lo + 4} h`, lo, hi: lo + 4 }));

export interface Stats {
  n: number;
  mean: DValue | null;
  median: DValue | null;
  p25: DValue | null;
  p75: DValue | null;
  min: DValue | null;
  max: DValue | null;
}

/** Quantile with linear interpolation between order statistics (Hyndman–Fan type 7). */
export function quantile(sorted: readonly DValue[], p: number): DValue | null {
  if (!sorted.length) return null;
  const h = new D(sorted.length - 1).times(p);
  const lo = h.floor().toNumber();
  const frac = h.minus(lo);
  const a = sorted[lo]!;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)]!;
  return a.plus(b.minus(a).times(frac));
}

export function stats(values: readonly DValue[]): Stats {
  const sorted = [...values].sort((a, b) => a.cmp(b));
  const n = sorted.length;
  return {
    n,
    mean: n ? sorted.reduce((s, x) => s.plus(x), new D(0)).div(n) : null,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0] ?? null,
    max: sorted[n - 1] ?? null,
  };
}

export interface CohortGroup {
  /** 1, 2 or 3 stars, or every event. */
  group: '1' | '2' | '3' | 'all';
  events: number;
  distinctAssets: number;
  final: number;
  incomplete: number;
  /** OPEN + TRACKING + AWAITING_FINAL_DAY. */
  pending: number;
  byStatus: Record<ForwardEventStatus, number>;
  /** peak_return_pct over FINAL events only. */
  finalReturns: Stats;
  returnDistribution: Bin[];
  detectionHourUtc: number[];
  horizonHours: Stats & { bins: Bin[] };
  correlation: {
    /** Assets with more than one event in the group. */
    assetsWithMultipleEvents: number;
    /** Events belonging to such assets. */
    eventsOnRepeatedAssets: number;
    /** Pairs of one asset's events whose windows overlap. */
    sameAssetOverlaps: number;
    detectionDates: number;
    /** Dates with more than one event (market-wide moves make same-day events correlated). */
    datesWithMultipleEvents: number;
    maxEventsPerDate: number;
  };
}

export interface CohortReport {
  groups: CohortGroup[];
  /** eventId → ids of the same asset's other events whose windows overlap (any star count). */
  overlaps: Map<string, string[]>;
  /** cmcId → number of events (any star count). */
  assetEventCounts: Map<number, number>;
}

type Span = Pick<CohortEvent, 'eventId' | 'cmcId' | 'detectedAt' | 'evaluationEnd'>;

const overlap = (a: Span, b: Span) =>
  a.detectedAt.getTime() <= b.evaluationEnd.getTime() &&
  b.detectedAt.getTime() <= a.evaluationEnd.getTime();

/**
 * Same-asset event pairs whose windows overlap. A sweep over each asset's events in detection
 * order: windows are about eight days long, so each event meets only its near neighbours (the
 * history is never pruned and grows by the day).
 */
function overlapPairs<T extends Span>(events: readonly T[]): Array<[T, T]> {
  const byAsset = new Map<number, T[]>();
  for (const e of events) {
    const list = byAsset.get(e.cmcId);
    if (list) list.push(e);
    else byAsset.set(e.cmcId, [e]);
  }
  const pairs: Array<[T, T]> = [];
  for (const list of byAsset.values()) {
    list.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length && overlap(list[i]!, list[j]!); j++)
        pairs.push([list[i]!, list[j]!]);
  }
  return pairs;
}

/** eventId → ids of the same asset's other events whose windows overlap (correlated observations). */
export function overlapMap(events: readonly Span[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [a, b] of overlapPairs(events)) {
    out.set(a.eventId, [...(out.get(a.eventId) ?? []), b.eventId]);
    out.set(b.eventId, [...(out.get(b.eventId) ?? []), a.eventId]);
  }
  return out;
}

function group(key: CohortGroup['group'], events: readonly CohortEvent[]): CohortGroup {
  const byStatus = Object.fromEntries(
    (['OPEN', 'TRACKING', 'AWAITING_FINAL_DAY', 'FINAL', 'INCOMPLETE'] as const).map((s) => [
      s,
      events.filter((e) => e.status === s).length,
    ]),
  ) as Record<ForwardEventStatus, number>;
  const finals = events
    .filter((e) => e.status === 'FINAL' && e.peakKind === 'EXACT' && e.peakReturnPct !== null)
    .map((e) => e.peakReturnPct!);
  const returnDistribution = RETURN_BINS.map((b) => ({
    label: b.label,
    count: finals.filter((v) => (b.min === null || v.gte(b.min)) && (b.max === null || v.lt(b.max)))
      .length,
  }));
  const detectionHourUtc = Array.from({ length: 24 }, () => 0);
  for (const e of events) detectionHourUtc[e.detectedAt.getUTCHours()]!++;
  const horizons = events.map((e) => e.effectiveHorizonHours);
  const perAsset = new Map<number, number>();
  for (const e of events) perAsset.set(e.cmcId, (perAsset.get(e.cmcId) ?? 0) + 1);
  const perDate = new Map<string, number>();
  for (const e of events) perDate.set(e.detectedUtcDate, (perDate.get(e.detectedUtcDate) ?? 0) + 1);
  const repeated = [...perAsset.values()].filter((n) => n > 1);
  return {
    group: key,
    events: events.length,
    distinctAssets: perAsset.size,
    final: byStatus.FINAL,
    incomplete: byStatus.INCOMPLETE,
    pending: ACTIVE_EVENT_STATUSES.reduce((s, st) => s + byStatus[st], 0),
    byStatus,
    finalReturns: stats(finals),
    returnDistribution,
    detectionHourUtc,
    horizonHours: {
      ...stats(horizons),
      bins: HORIZON_BINS.map((b) => ({
        label: b.label,
        count: horizons.filter((h) => h.gt(b.lo) && h.lte(b.hi)).length,
      })),
    },
    correlation: {
      assetsWithMultipleEvents: repeated.length,
      eventsOnRepeatedAssets: repeated.reduce((s, n) => s + n, 0),
      sameAssetOverlaps: overlapPairs(events).length,
      detectionDates: perDate.size,
      datesWithMultipleEvents: [...perDate.values()].filter((n) => n > 1).length,
      maxEventsPerDate: Math.max(0, ...perDate.values()),
    },
  };
}

export function cohortReport(events: readonly CohortEvent[]): CohortReport {
  const overlaps = overlapMap(events);
  const assetEventCounts = new Map<number, number>();
  for (const e of events) assetEventCounts.set(e.cmcId, (assetEventCounts.get(e.cmcId) ?? 0) + 1);
  return {
    groups: [
      ...(['1', '2', '3'] as const).map((s) =>
        group(
          s,
          events.filter((e) => String(e.stars) === s),
        ),
      ),
      group('all', events),
    ],
    overlaps,
    assetEventCounts,
  };
}

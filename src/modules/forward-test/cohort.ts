import { D, type DValue } from '../../common/utils/decimal.js';

import { type PassStatus, rankingScore } from '../strategy/index.js';

import {
  ACTIVE_EVENT_STATUSES,
  type ForwardEventStatus,
  type PeakKind,
} from './forward.constants.js';

/**
 * Star-group comparison (PDF p.9), pure and exact, by star count, by detection-time pass pattern
 * and by weighted-points band (Weighted Star Ranking addendum § 5). Primary aggregates use only
 * FINAL events (every included period covered, exact peak); everything else is counted, never
 * averaged in. Events of one asset or one day are correlated observations: they are identified,
 * not treated as independent trades. Nothing here feeds back into a score.
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
  /** Detection-time 3d / 7d / 30d results (the pattern label is derived, never parsed). */
  passes: readonly [PassStatus, PassStatus, PassStatus];
  /** Detection-time weighted pass points and completeness; null when detected before the ranking. */
  weightedPassPoints: number | null;
  scoreComplete: boolean | null;
  /** At least one High check has evaluated the event (it has an outcome). */
  checked: boolean;
  /**
   * The signal-day High is not proven to come after detection and no later High reached it
   * (DAY0_UNRESOLVED / INCOMPLETE_DAY0): that High never counts as a confirmed result.
   */
  day0Unconfirmed: boolean;
}

/**
 * Bands of weighted pass points, compared on complete scores only (an incomplete score is a lower
 * bound and gets its own group). Equal-width and fixed in advance: display bands, not thresholds.
 */
export const POINTS_BANDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '75–100 points', min: 75, max: 100 },
  { label: '50–74 points', min: 50, max: 74 },
  { label: '25–49 points', min: 25, max: 49 },
  { label: '0–24 points', min: 0, max: 24 },
];
export const INCOMPLETE_SCORE_GROUP = 'incomplete score (lower bound)';

/** Display label of a 3d / 7d / 30d result triple, e.g. `N/A/YES/YES`. */
export const passPattern = (p: readonly [PassStatus, PassStatus, PassStatus]) => p.join('/');
export const UNSCORED_GROUP = 'no score (detected before weighted_star_v1)';

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

export type CohortDimension = 'stars' | 'pass_pattern' | 'points_band';

export interface CohortGroup {
  dimension: CohortDimension;
  /** Stars `1` / `2` / `3` / `all`, a pass pattern (`YES/NO/N/A`) or a points band. */
  group: string;
  events: number;
  distinctAssets: number;
  final: number;
  incomplete: number;
  /** OPEN + TRACKING + AWAITING_FINAL_DAY. */
  pending: number;
  /** FINAL + INCOMPLETE: the window has closed. */
  completed: number;
  byStatus: Record<ForwardEventStatus, number>;
  /** Events with a confirmed highest High (an eligible post-detection High), any status. */
  confirmedHigh: number;
  /** Events not checked yet (signal day still open, or no update since it closed). */
  awaitingCheck: number;
  /** Events whose only candidate High is the unconfirmed signal-day High (see CohortEvent). */
  day0Unconfirmed: number;
  /** peak_return_pct over FINAL events only. */
  finalReturns: Stats;
  /**
   * Provisional peak_return_pct (lower bounds) of active events with a confirmed High. Kept apart
   * from finalReturns: an open window can still rise.
   */
  activeReturns: Stats;
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
  /** By star count, then all events. */
  groups: CohortGroup[];
  /** By detection-time pass pattern, in queue order of the pattern (stars, points, complete). */
  patterns: CohortGroup[];
  /** By weighted-points band (complete scores), then incomplete and unscored events. */
  pointsBands: CohortGroup[];
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

/** One event's Return as the dashboard shows it: its latest outcome's peak return and peak kind. */
export interface CoinReturnInput {
  cmcId: number;
  peakKind: PeakKind | null;
  peakReturnPct: DValue | null;
}

export interface CoinAverageReturn {
  /** Every stored event of the coin, any status and star count. */
  events: number;
  /** Events with a numeric Return. The others are left out, never counted as 0 %. */
  withReturn: number;
  /** Of those, Returns that are not EXACT (shown as ≥: window open, final day pending or a gap). */
  lowerBounds: number;
  /** Arithmetic mean of those Returns; itself a lower bound when `lowerBounds > 0`. */
  average: DValue | null;
}

/**
 * Average Return per coin, by CMC id (never by symbol), over every stored event of the coin. The
 * Return is the peak return (maximum price increase after identification), not trading profit.
 * Every true Return is at least its shown lower bound, so a mean that includes one is a lower bound
 * of the mean too. Descriptive: one coin's events are correlated observations, not separate trades.
 */
export function coinAverageReturns(
  events: readonly CoinReturnInput[],
): Map<number, CoinAverageReturn> {
  const byCoin = new Map<number, { events: number; returns: DValue[]; lowerBounds: number }>();
  for (const e of events) {
    let c = byCoin.get(e.cmcId);
    if (!c) byCoin.set(e.cmcId, (c = { events: 0, returns: [], lowerBounds: 0 }));
    c.events++;
    if (e.peakReturnPct === null) continue;
    c.returns.push(e.peakReturnPct);
    if (e.peakKind !== 'EXACT') c.lowerBounds++;
  }
  return new Map(
    [...byCoin].map(([cmcId, c]) => [
      cmcId,
      {
        events: c.events,
        withReturn: c.returns.length,
        lowerBounds: c.lowerBounds,
        average: c.returns.length
          ? c.returns.reduce((sum, r) => sum.plus(r), new D(0)).div(c.returns.length)
          : null,
      },
    ]),
  );
}

function group(
  dimension: CohortDimension,
  key: string,
  events: readonly CohortEvent[],
): CohortGroup {
  const byStatus = Object.fromEntries(
    (['OPEN', 'TRACKING', 'AWAITING_FINAL_DAY', 'FINAL', 'INCOMPLETE'] as const).map((s) => [
      s,
      events.filter((e) => e.status === s).length,
    ]),
  ) as Record<ForwardEventStatus, number>;
  const finals = events
    .filter((e) => e.status === 'FINAL' && e.peakKind === 'EXACT' && e.peakReturnPct !== null)
    .map((e) => e.peakReturnPct!);
  const actives = events
    .filter((e) => ACTIVE_EVENT_STATUSES.includes(e.status) && e.peakReturnPct !== null)
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
    dimension,
    group: key,
    events: events.length,
    distinctAssets: perAsset.size,
    final: byStatus.FINAL,
    incomplete: byStatus.INCOMPLETE,
    pending: ACTIVE_EVENT_STATUSES.reduce((s, st) => s + byStatus[st], 0),
    completed: byStatus.FINAL + byStatus.INCOMPLETE,
    byStatus,
    confirmedHigh: events.filter((e) => e.peakReturnPct !== null).length,
    awaitingCheck: events.filter((e) => !e.checked).length,
    day0Unconfirmed: events.filter((e) => e.day0Unconfirmed).length,
    finalReturns: stats(finals),
    activeReturns: stats(actives),
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

  // `N/A` contains a slash, so a label is never split back into statuses.
  const byPattern = new Map<string, CohortEvent['passes']>();
  for (const e of events) byPattern.set(passPattern(e.passes), e.passes);
  const patternRank = (pattern: string) => {
    const [p3, p7, p30] = byPattern.get(pattern)!;
    return rankingScore({
      pass3d: p3,
      pass7d: p7,
      pass30d: p30,
      multiple3d: null,
      multiple7d: null,
      multiple30d: null,
    });
  };
  const patterns = [...byPattern.keys()].sort((a, b) => {
    const x = patternRank(a);
    const y = patternRank(b);
    return (
      y.stars - x.stars ||
      y.weightedPassPoints - x.weightedPassPoints ||
      Number(y.scoreComplete) - Number(x.scoreComplete) ||
      a.localeCompare(b)
    );
  });
  const scored = events.filter((e) => e.weightedPassPoints !== null && e.scoreComplete !== null);
  const unscored = events.filter((e) => e.weightedPassPoints === null || e.scoreComplete === null);
  return {
    groups: [
      ...(['1', '2', '3'] as const).map((s) =>
        group(
          'stars',
          s,
          events.filter((e) => String(e.stars) === s),
        ),
      ),
      group('stars', 'all', events),
    ],
    patterns: patterns.map((p) =>
      group(
        'pass_pattern',
        p,
        events.filter((e) => passPattern(e.passes) === p),
      ),
    ),
    pointsBands: [
      ...POINTS_BANDS.map((b) =>
        group(
          'points_band',
          b.label,
          scored.filter(
            (e) =>
              e.scoreComplete && e.weightedPassPoints! >= b.min && e.weightedPassPoints! <= b.max,
          ),
        ),
      ),
      group(
        'points_band',
        INCOMPLETE_SCORE_GROUP,
        scored.filter((e) => !e.scoreComplete),
      ),
      ...(unscored.length ? [group('points_band', UNSCORED_GROUP, unscored)] : []),
    ],
    overlaps,
    assetEventCounts,
  };
}

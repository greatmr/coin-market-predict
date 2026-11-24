import { D, type DValue } from '../../common/utils/decimal.js';

import {
  ELIGIBILITY_CLASSES,
  type EligibilityClass,
  OBSERVATION_STATUSES,
  type ObservationStatus,
} from './observation.constants.js';

/**
 * Summary statistics of LBank observations (docs/lbank-spot-observation.md § 7), pure and exact.
 * Maximum rise and maximum drop are two independent price extremes, never profit or a tested stop.
 * Only FINAL observations enter the statistics; every count states its denominator, in events and
 * in distinct coins, because one coin's overlapping events are correlated, not independent.
 */
export interface StatsRow {
  id: string;
  cmcId: number;
  stars: number;
  status: ObservationStatus;
  eligibility: EligibilityClass;
  t0Ms: number;
  windowEndMs: number;
  maxRisePct: DValue | null;
  maxDropPct: DValue | null;
}

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
  const a = sorted[lo]!;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)]!;
  return a.plus(b.minus(a).times(h.minus(lo)));
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

export interface Count {
  events: number;
  coins: number;
}

const count = (rows: readonly StatsRow[]): Count => ({
  events: rows.length,
  coins: new Set(rows.map((r) => r.cmcId)).size,
});

export interface FinalGroup extends Count {
  key: string;
  rise: Stats;
  drop: Stats;
}

export interface ObservationSummary {
  total: Count;
  byStatus: Record<ObservationStatus, Count>;
  byEligibility: Record<EligibilityClass, Count>;
  /** FINAL observations only: the denominator of every statistic below. */
  final: Count & { rise: Stats; drop: Stats; byStars: FinalGroup[]; byEligibility: FinalGroup[] };
  /** ACTIVE and PARTIAL: provisional extremes, shown but never in a statistic. */
  provisional: Count;
  /** DATA_UNAVAILABLE, MAPPING_AMBIGUOUS, ELIGIBILITY_UNKNOWN: no LBank measurement. */
  unmeasured: Count;
  correlation: {
    /** Coins with more than one event, and how many events they have together. */
    coinsWithSeveralEvents: number;
    eventsOfThoseCoins: number;
    /** Pairs of the same coin's events whose 168 h windows overlap. */
    overlappingPairs: number;
  };
}

function finalGroup(key: string, rows: readonly StatsRow[]): FinalGroup {
  return {
    key,
    ...count(rows),
    rise: stats(rows.map((r) => r.maxRisePct!)),
    drop: stats(rows.map((r) => r.maxDropPct!)),
  };
}

export function summarize(rows: readonly StatsRow[]): ObservationSummary {
  const byStatus = Object.fromEntries(
    OBSERVATION_STATUSES.map((s) => [s, count(rows.filter((r) => r.status === s))]),
  ) as Record<ObservationStatus, Count>;
  const byEligibility = Object.fromEntries(
    ELIGIBILITY_CLASSES.map((c) => [c, count(rows.filter((r) => r.eligibility === c))]),
  ) as Record<EligibilityClass, Count>;
  const final = rows.filter(
    (r) => r.status === 'FINAL' && r.maxRisePct !== null && r.maxDropPct !== null,
  );
  const perCoin = new Map<number, StatsRow[]>();
  for (const r of rows) perCoin.set(r.cmcId, [...(perCoin.get(r.cmcId) ?? []), r]);
  let several = 0;
  let severalEvents = 0;
  let overlapping = 0;
  for (const list of perCoin.values()) {
    if (list.length > 1) {
      several++;
      severalEvents += list.length;
    }
    const sorted = [...list].sort((a, b) => a.t0Ms - b.t0Ms);
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length && sorted[j]!.t0Ms < sorted[i]!.windowEndMs; j++)
        overlapping++;
  }
  return {
    total: count(rows),
    byStatus,
    byEligibility,
    final: {
      ...count(final),
      rise: stats(final.map((r) => r.maxRisePct!)),
      drop: stats(final.map((r) => r.maxDropPct!)),
      byStars: [1, 2, 3].map((s) =>
        finalGroup(
          String(s),
          final.filter((r) => r.stars === s),
        ),
      ),
      byEligibility: ELIGIBILITY_CLASSES.map((c) =>
        finalGroup(
          c,
          final.filter((r) => r.eligibility === c),
        ),
      ).filter((g) => g.events > 0),
    },
    provisional: count(rows.filter((r) => r.status === 'ACTIVE' || r.status === 'PARTIAL')),
    unmeasured: count(
      rows.filter(
        (r) =>
          r.status === 'DATA_UNAVAILABLE' ||
          r.status === 'MAPPING_AMBIGUOUS' ||
          r.status === 'ELIGIBILITY_UNKNOWN',
      ),
    ),
    correlation: {
      coinsWithSeveralEvents: several,
      eventsOfThoseCoins: severalEvents,
      overlappingPairs: overlapping,
    },
  };
}

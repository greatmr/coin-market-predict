import { D, type DValue } from '../../common/utils/decimal.js';

import {
  ELIGIBILITY_CLASSES,
  type EligibilityClass,
  OBSERVATION_RULES_VERSION,
  OBSERVATION_STATUSES,
  OBS_FLAG,
  type ObservationStatus,
} from './observation.constants.js';

/**
 * Summary statistics of LBank observations (docs/lbank-spot-observation.md § 8), pure and exact.
 * Highest and lowest return are two independent price extremes relative to the reference trade,
 * never profit, never summed and never a tested stop. Only FINAL observations of the current rules
 * enter the statistics; every count states its denominator in events and in distinct coins,
 * because one coin's overlapping events follow one price path and are correlated, not independent.
 * No coin-level weighting is applied (none is defined).
 */
export interface StatsRow {
  id: string;
  cmcId: number;
  stars: number;
  status: ObservationStatus;
  rulesVersion: string;
  eligibility: EligibilityClass;
  startMs: number | null;
  endMs: number | null;
  highestPct: DValue | null;
  lowestPct: DValue | null;
  flags: readonly string[];
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
  highest: Stats;
  lowest: Stats;
}

export interface ObservationSummary {
  rulesVersion: string;
  total: Count;
  byStatus: Record<ObservationStatus, Count>;
  byEligibility: Record<EligibilityClass, Count>;
  /** FINAL observations of the current rules only: the denominator of every statistic below. */
  final: Count & {
    highest: Stats;
    lowest: Stats;
    byStars: FinalGroup[];
    byEligibility: FinalGroup[];
    /** Final events carrying a single-trade (thin-market) extreme or a delayed reference: kept. */
    flagged: { singleTrade: Count; delayedReference: Count };
  };
  /** ACTIVE: provisional values, shown but never in a statistic. */
  provisional: Count;
  /** PARTIAL: window over, coverage incomplete after the retries (values over the covered part). */
  partial: Count;
  /** NO_TRADES: the complete window held no trade (no return exists). */
  noTrades: Count;
  /** UNVERIFIABLE: no provable reference trade. */
  unverifiable: Count;
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
    highest: stats(rows.map((r) => r.highestPct!)),
    lowest: stats(rows.map((r) => r.lowestPct!)),
  };
}

const SINGLE_TRADE: readonly string[] = [OBS_FLAG.singleTradeHigh, OBS_FLAG.singleTradeLow];

export function summarize(rows: readonly StatsRow[]): ObservationSummary {
  const byStatus = Object.fromEntries(
    OBSERVATION_STATUSES.map((s) => [s, count(rows.filter((r) => r.status === s))]),
  ) as Record<ObservationStatus, Count>;
  const byEligibility = Object.fromEntries(
    ELIGIBILITY_CLASSES.map((c) => [c, count(rows.filter((r) => r.eligibility === c))]),
  ) as Record<EligibilityClass, Count>;
  const final = rows.filter(
    (r) =>
      r.status === 'FINAL' &&
      r.rulesVersion === OBSERVATION_RULES_VERSION &&
      r.highestPct !== null &&
      r.lowestPct !== null,
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
    const timed = list
      .filter((r) => r.startMs !== null && r.endMs !== null)
      .sort((a, b) => a.startMs! - b.startMs!);
    for (let i = 0; i < timed.length; i++)
      for (let j = i + 1; j < timed.length && timed[j]!.startMs! < timed[i]!.endMs!; j++)
        overlapping++;
  }
  const is = (...s: ObservationStatus[]) => count(rows.filter((r) => s.includes(r.status)));
  return {
    rulesVersion: OBSERVATION_RULES_VERSION,
    total: count(rows),
    byStatus,
    byEligibility,
    final: {
      ...count(final),
      highest: stats(final.map((r) => r.highestPct!)),
      lowest: stats(final.map((r) => r.lowestPct!)),
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
      flagged: {
        singleTrade: count(final.filter((r) => r.flags.some((f) => SINGLE_TRADE.includes(f)))),
        delayedReference: count(final.filter((r) => r.flags.includes(OBS_FLAG.referenceDelayed))),
      },
    },
    provisional: is('ACTIVE'),
    partial: is('PARTIAL'),
    noTrades: is('NO_TRADES'),
    unverifiable: is('UNVERIFIABLE'),
    unmeasured: is('DATA_UNAVAILABLE', 'MAPPING_AMBIGUOUS', 'ELIGIBILITY_UNKNOWN'),
    correlation: {
      coinsWithSeveralEvents: several,
      eventsOfThoseCoins: severalEvents,
      overlappingPairs: overlapping,
    },
  };
}

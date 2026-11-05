import { D, type DValue } from "../common/decimal.js";
import { completedDates, type IsoDate } from "../common/dates.js";
import { type CurrentStatus, FUTURE_TOLERANCE_MS, type PassStatus, type PassWindow, REASON, RULES, type WindowDays } from "./constants.js";

/**
 * VMC arithmetic (PDF p.11–14), pure and exact. Ratios are computed from the stored source
 * values at 80 significant digits; nothing is rounded before a comparison.
 */

export interface DailyInput {
  dateUtc: IsoDate;
  volume: DValue | null;
  marketCap: DValue | null;
  /** False when the source row itself was rejected (e.g. non-numeric field). */
  valid: boolean;
  invalidReasons?: string[];
  revisionId?: string | null;
  close?: DValue | null;
}

/** daily_vmc = volume / cap; valid only for finite volume ≥ 0 and finite cap > 0 (p.11). */
export function dailyRatio(volume: DValue | null, cap: DValue | null): { ratio: DValue | null; reasons: string[] } {
  const reasons: string[] = [];
  if (volume === null) reasons.push("volume_missing");
  else if (!volume.isFinite()) reasons.push("volume_not_finite");
  else if (volume.isNegative() && !volume.isZero()) reasons.push("volume_negative");
  if (cap === null) reasons.push("market_cap_missing");
  else if (!cap.isFinite()) reasons.push("market_cap_not_finite");
  else if (cap.isZero()) reasons.push("market_cap_zero");
  else if (cap.isNegative()) reasons.push("market_cap_negative");
  return reasons.length ? { ratio: null, reasons } : { ratio: volume!.div(cap!), reasons };
}

export interface WindowResult {
  days: WindowDays;
  /** Completed dates T−1 … T−N (newest first). */
  dates: IsoDate[];
  mean: DValue | null;
  reason: string | null;
  missingDates: IsoDate[];
  invalidDates: IsoDate[];
  /** Diagnostic only (p.14): arithmetic mean of the same dates' daily volumes. */
  volumeMean: DValue | null;
  revisionIds: Array<string | null>;
}

/**
 * Mean of daily ratios over exactly the last N completed UTC dates (p.11). A missing or invalid
 * date makes this window N/A; it is never skipped, zero-filled or replaced by a shorter mean.
 */
export function windowMean(asOf: Date, rows: ReadonlyMap<IsoDate, DailyInput>, days: WindowDays): WindowResult {
  const dates = completedDates(asOf, days);
  const missingDates: IsoDate[] = [];
  const invalidDates: IsoDate[] = [];
  const ratios: DValue[] = [];
  const volumes: DValue[] = [];
  const revisionIds: Array<string | null> = [];
  for (const date of dates) {
    const row = rows.get(date);
    if (!row) {
      missingDates.push(date);
      revisionIds.push(null);
      continue;
    }
    revisionIds.push(row.revisionId ?? null);
    const r = dailyRatio(row.volume, row.marketCap);
    if (!row.valid || r.ratio === null) {
      invalidDates.push(date);
      continue;
    }
    ratios.push(r.ratio);
    volumes.push(row.volume!);
  }
  const base = { days, dates, missingDates, invalidDates, revisionIds };
  if (missingDates.length) return { ...base, mean: null, reason: REASON.dailyRowMissing, volumeMean: null };
  if (invalidDates.length) return { ...base, mean: null, reason: REASON.dailyRowInvalid, volumeMean: null };
  const mean = ratios.reduce((s, x) => s.plus(x), new D(0)).div(days);
  const volumeMean = volumes.reduce((s, x) => s.plus(x), new D(0)).div(days);
  return { ...base, mean, reason: mean.isZero() ? REASON.zeroBaseline : null, volumeMean };
}

export interface CurrentInput {
  /** The asset has an observation in this crawl batch. */
  present: boolean;
  volume24h: DValue | null;
  marketCap: DValue | null;
  /** Market cap reported by the provider (not calculated from supply, never FDV). */
  capProviderReported: boolean;
  /** Provider update time. */
  observedAt: Date | null;
  /** Crawl time. */
  collectedAt: Date | null;
  /** Volume and cap come from the same snapshot and USD conversion. */
  sameObservation: boolean;
}

export interface CurrentResult {
  status: CurrentStatus;
  reason: string | null;
  /** volume_24h / market_cap; null when the inputs cannot form a ratio. */
  vmc: DValue | null;
  quoteAgeMs: number | null;
}

/** current_vmc and its status (p.12, p.13). Anything but OK makes every comparison N/A. */
export function currentObservation(c: CurrentInput, maxQuoteAgeMs: number): CurrentResult {
  if (!c.present) return { status: "MISSING", reason: REASON.currentMissing, vmc: null, quoteAgeMs: null };
  if (!c.sameObservation) return { status: "MISMATCHED", reason: REASON.mismatched, vmc: null, quoteAgeMs: null };
  const quoteAgeMs = c.observedAt && c.collectedAt ? c.collectedAt.getTime() - c.observedAt.getTime() : null;
  if (c.marketCap === null || !c.capProviderReported || !c.marketCap.isFinite() || c.marketCap.lte(0)) {
    return { status: "INVALID", reason: REASON.capInvalid, vmc: null, quoteAgeMs };
  }
  if (c.volume24h === null || !c.volume24h.isFinite() || (c.volume24h.isNegative() && !c.volume24h.isZero())) {
    return { status: "INVALID", reason: REASON.volumeInvalid, vmc: null, quoteAgeMs };
  }
  const vmc = c.volume24h.div(c.marketCap);
  if (!c.observedAt || !c.collectedAt) return { status: "TIMESTAMP_UNVERIFIED", reason: REASON.timestampMissing, vmc, quoteAgeMs };
  if (quoteAgeMs! < -FUTURE_TOLERANCE_MS) return { status: "TIMESTAMP_UNVERIFIED", reason: REASON.timestampFuture, vmc, quoteAgeMs };
  if (quoteAgeMs! > maxQuoteAgeMs) return { status: "STALE", reason: REASON.currentStale, vmc, quoteAgeMs };
  return { status: "OK", reason: null, vmc, quoteAgeMs };
}

export interface Comparison {
  multiple: DValue | null;
  status: PassStatus;
  reason: string | null;
}

const THRESHOLD = new D(RULES.passMultiple);

/**
 * multiple_N = current / mean_N; YES iff multiple_N ≥ 1.5. Evaluated as current ≥ 1.5 × mean_N
 * (identical for mean_N > 0, one rounding step fewer — assumption A4).
 */
export function compare(current: CurrentResult, w: Pick<WindowResult, "mean" | "reason">): Comparison {
  if (current.status !== "OK" || current.vmc === null) return { multiple: null, status: "N/A", reason: current.reason ?? REASON.currentMissing };
  if (w.mean === null) return { multiple: null, status: "N/A", reason: w.reason ?? REASON.dailyRowMissing };
  if (w.mean.isZero()) return { multiple: null, status: "N/A", reason: REASON.zeroBaseline };
  return { multiple: current.vmc.div(w.mean), status: current.vmc.gte(w.mean.times(THRESHOLD)) ? "YES" : "NO", reason: null };
}

export interface VmcEvaluation {
  current: CurrentResult;
  windows: Record<WindowDays, WindowResult>;
  comparisons: Record<PassWindow, Comparison>;
  stars: number;
  /** Optional diagnostics (p.14); never pass/fail. */
  diagnostics: { volumeAvg: Record<WindowDays, DValue | null>; volumeRatio24h: Record<WindowDays, DValue | null> };
}

export function evaluateVmc(asOf: Date, rows: ReadonlyMap<IsoDate, DailyInput>, current: CurrentInput, maxQuoteAgeMs: number): VmcEvaluation {
  const cur = currentObservation(current, maxQuoteAgeMs);
  const windows = Object.fromEntries(RULES.windows.map((n) => [n, windowMean(asOf, rows, n)])) as Record<WindowDays, WindowResult>;
  const comparisons = Object.fromEntries(RULES.passWindows.map((n) => [n, compare(cur, windows[n])])) as Record<PassWindow, Comparison>;
  const stars = RULES.passWindows.filter((n) => comparisons[n].status === "YES").length;
  const volumeAvg = Object.fromEntries(RULES.windows.map((n) => [n, windows[n].volumeMean])) as Record<WindowDays, DValue | null>;
  const volumeRatio24h = Object.fromEntries(
    RULES.windows.map((n) => {
      const avg = windows[n].volumeMean;
      return [n, cur.status === "OK" && current.volume24h && avg && !avg.isZero() ? current.volume24h.div(avg) : null];
    }),
  ) as Record<WindowDays, DValue | null>;
  return { current: cur, windows, comparisons, stars, diagnostics: { volumeAvg, volumeRatio24h } };
}

/** Comparisons for an excluded asset: not evaluated (no daily history is fetched for it). */
export function notEvaluated(): Record<PassWindow, Comparison> {
  return Object.fromEntries(RULES.passWindows.map((n) => [n, { multiple: null, status: "N/A" as const, reason: REASON.notEvaluated }])) as Record<PassWindow, Comparison>;
}

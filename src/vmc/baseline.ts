import { type Decimal, meanOf, sha256 } from "./decimal.js";
import { type BaselineWindow, eachDay, type IsoDate } from "./window.js";

export const BASELINE_FORMULA_VERSION = "vmc-baseline-1: mean(volume_d / market_cap_d) over valid completed UTC days";

/** One effective (current-revision) daily observation from the database. */
export interface DailyInput {
  observationId: bigint;
  dateUtc: IsoDate;
  valid: boolean;
  ratio: Decimal | null;
  invalidReasons: string[];
}

export interface BaselineResult {
  status: "full" | "partial" | "unavailable";
  statusReasons: string[];
  expectedDays: number;
  returnedDays: number;
  validDays: number;
  invalidDays: number;
  missingDays: number;
  coverage: number;
  ratioSum: Decimal | null;
  meanRatio: Decimal | null;
  firstValidDate: IsoDate | null;
  lastValidDate: IsoDate | null;
  members: Array<{ observationId: bigint; dateUtc: IsoDate; ratio: Decimal | null; included: boolean; reason: string | null }>;
  missingDates: IsoDate[];
  inputsHash: string;
}

/**
 * Baseline = sum(valid daily ratios) / valid_day_count — the arithmetic mean of ratios.
 * It is NOT total volume / total market cap, nor mean volume / mean market cap, nor weighted.
 * Missing days are never filled; invalid days are excluded and counted.
 */
export function computeBaseline(
  window: BaselineWindow,
  inputs: DailyInput[],
  opts: { minCoverage: number; firstHistoricalDate: IsoDate | null; convention: string },
): BaselineResult {
  const inWindow = inputs.filter((i) => i.dateUtc >= window.start && i.dateUtc <= window.end);
  const byDate = new Map(inWindow.map((i) => [i.dateUtc, i]));
  const missingDates = eachDay(window.start, window.end).filter((d) => !byDate.has(d));
  const members = inWindow
    .sort((a, b) => a.dateUtc.localeCompare(b.dateUtc))
    .map((i) => {
      const ok = i.valid && i.ratio !== null;
      return { observationId: i.observationId, dateUtc: i.dateUtc, ratio: i.ratio, included: ok, reason: ok ? null : i.invalidReasons.join(",") || "invalid" };
    });
  const valid = members.filter((m) => m.included);
  const validDays = valid.length;
  const coverage = window.expectedDays ? validDays / window.expectedDays : 0;
  const reasons: string[] = [];
  let status: BaselineResult["status"];
  let ratioSum: Decimal | null = null;
  let meanRatio: Decimal | null = null;

  if (validDays === 0) {
    status = "unavailable";
    reasons.push(inWindow.length === 0 ? "no_daily_records_in_window" : "no_valid_daily_records");
  } else {
    const m = meanOf(valid.map((v) => v.ratio!));
    ratioSum = m.sum;
    meanRatio = m.mean;
    const young = opts.firstHistoricalDate !== null && opts.firstHistoricalDate > window.start;
    if (young) reasons.push(`asset_history_starts_${opts.firstHistoricalDate}_after_window_start`);
    if (coverage < opts.minCoverage) reasons.push(`coverage_${(coverage * 100).toFixed(1)}pct_below_${(opts.minCoverage * 100).toFixed(1)}pct`);
    status = young || coverage < opts.minCoverage ? "partial" : "full";
  }

  const inputsHash = sha256(
    JSON.stringify({
      window,
      convention: opts.convention,
      formula: BASELINE_FORMULA_VERSION,
      members: members.map((m) => [m.observationId.toString(), m.dateUtc, m.ratio?.toString() ?? null, m.included]),
    }),
  );

  return {
    status,
    statusReasons: reasons,
    expectedDays: window.expectedDays,
    returnedDays: inWindow.length,
    validDays,
    invalidDays: inWindow.length - validDays,
    missingDays: missingDates.length,
    coverage,
    ratioSum,
    meanRatio,
    firstValidDate: valid[0]?.dateUtc ?? null,
    lastValidDate: valid.at(-1)?.dateUtc ?? null,
    members,
    missingDates,
    inputsHash,
  };
}

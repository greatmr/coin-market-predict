/**
 * Calendar helpers for the six-month baseline. Dates are UTC calendar days represented as
 * `YYYY-MM-DD` strings (no time component) to avoid timezone drift.
 *
 * Window definition (docs/volume-mcap.md):
 *   windowEnd   = latest COMPLETED UTC day = (UTC date of `now`) − 1 day
 *   windowStart = (windowEnd − N calendar months, clamped to month end) + 1 day
 *   Both bounds are inclusive. Example (N=6): end 2026-11-02 → start 2026-05-03 (184 days).
 */

export type IsoDate = string;

export function isoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function parseIsoDate(s: IsoDate): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`invalid date ${s}`);
  return new Date(`${s}T00:00:00.000Z`);
}

export function addDays(s: IsoDate, n: number): IsoDate {
  const d = parseIsoDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/** Subtract calendar months, clamping the day to the target month's length (Aug 31 − 6m = Feb 28/29). */
export function addCalendarMonths(s: IsoDate, months: number): IsoDate {
  const d = parseIsoDate(s);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return isoDate(target);
}

export function daysInclusive(start: IsoDate, end: IsoDate): number {
  return Math.round((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / 86_400_000) + 1;
}

export function eachDay(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface BaselineWindow {
  start: IsoDate;
  end: IsoDate;
  expectedDays: number;
}

export function baselineWindow(now: Date, months: number): BaselineWindow {
  const end = addDays(isoDate(now), -1);
  const start = addDays(addCalendarMonths(end, -months), 1);
  return { start, end, expectedDays: daysInclusive(start, end) };
}

export const HOUR_MS = 3_600_000;

export function hourFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

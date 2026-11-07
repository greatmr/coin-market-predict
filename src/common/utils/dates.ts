/**
 * UTC calendar dates as `YYYY-MM-DD` strings (no time component, no timezone drift).
 * Completed-day windows are built from these (docs/strategy-two-tier-vmc.md §5).
 */
export type IsoDate = string;

export const DAY_MS = 86_400_000;

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

export function daysInclusive(start: IsoDate, end: IsoDate): number {
  return Math.round((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / DAY_MS) + 1;
}

export function eachDay(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The N completed UTC dates before `asOf`'s date, newest first: T−1 … T−N (assumption A2). */
export function completedDates(asOf: Date, n: number): IsoDate[] {
  const today = isoDate(asOf);
  return Array.from({ length: n }, (_, i) => addDays(today, -(i + 1)));
}

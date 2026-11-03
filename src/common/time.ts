export const HOUR_MS = 3_600_000;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Start of the UTC hour containing `d`. All snapshots are bucketed into these slots. */
export function slotOf(d: Date): Date {
  const t = d.getTime();
  return new Date(t - (((t % HOUR_MS) + HOUR_MS) % HOUR_MS));
}

export function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * HOUR_MS);
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / HOUR_MS;
}

export function isSlotAligned(d: Date): boolean {
  return d.getTime() % HOUR_MS === 0;
}

/** Format a UTC instant in the configured display timezone (storage stays UTC). */
export function formatInZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

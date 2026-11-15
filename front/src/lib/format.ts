// Display formatting only. Every number arrives from the API already computed with exact decimals;
// these helpers round for display and never feed a comparison back to the server.
import type { Num } from '../types/api';

type Maybe<T> = T | null | undefined;

export const num = (x: Maybe<Num> | ''): number | null =>
  x === null || x === undefined || x === '' ? null : Number(x);
export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Display timezone from /api/config (set once after sign-in). */
let displayTz = 'UTC';
export function setDisplayTimezone(tz: string | null | undefined): void {
  displayTz = tz || 'UTC';
}
export const tz = (): string => displayTz;

export const nf = (o: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', o);

export function fmtInt(n: Maybe<Num>): string {
  const v = num(n);
  return isNum(v) ? nf({ maximumFractionDigits: 0 }).format(v) : '—';
}
export function fmtUsd(n: Maybe<Num>): string {
  const v = num(n);
  if (!isNum(v)) return '—';
  const big = Math.abs(v) >= 1e6;
  return nf({
    style: 'currency',
    currency: 'USD',
    notation: big ? 'compact' : 'standard',
    maximumFractionDigits: big ? 2 : 0,
  }).format(v);
}
export function fmtPrice(n: Maybe<Num>): string {
  const v = num(n);
  if (!isNum(v)) return '—';
  if (v >= 1000)
    return nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
  if (v >= 1) return nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(v);
  return `$${v.toPrecision(4)}`;
}
/** VMC as percent (PDF p.13: 0.20 = 20%), optionally with the raw ratio. */
export function fmtVmc(x: Maybe<Num>, withRatio = false): string {
  const v = num(x);
  if (!isNum(v)) return '—';
  const p = v * 100;
  const pct = `${p.toFixed(p >= 10 ? 1 : p >= 1 ? 2 : 3)}%`;
  return withRatio ? `${pct} (${v.toPrecision(4)})` : pct;
}
export function fmtMult(x: Maybe<Num>): string {
  const v = num(x);
  return isNum(v) ? `${v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)}×` : '—';
}
/** Signed percent from a value already in percent units, for display only (forward test returns). */
export function fmtPct(x: Maybe<Num>): string {
  const v = num(x);
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  return `${v > 0 ? '+' : ''}${v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)}%`;
}
export function fmtTime(iso: Maybe<string>, opts: { year?: boolean } = {}): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: tz(),
    year: opts.year ? 'numeric' : undefined,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
export const fmtClock = (iso: Maybe<string>): string =>
  iso
    ? new Date(iso).toLocaleTimeString('en-GB', {
        timeZone: tz(),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '—';
export const fmtDay = (ymd: string): string =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
export function fmtAgo(iso: Maybe<string>, now = Date.now()): string {
  if (!iso) return '—';
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
/** "1 h 05 min", "4 min 12 s", "38 s". */
export function fmtSpan(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    sec = t % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}
export const fmtMs = (ms: Maybe<number>): string =>
  isNum(ms) ? (ms < 1000 ? `${Math.round(ms)} ms` : fmtSpan(ms / 1000)) : '';
export const utc = (iso: Maybe<string>): string => (iso ? String(iso).replace('.000Z', 'Z') : '—');
export const shortId = (id: Maybe<string>): string => String(id || '').slice(0, 8);

/** Countdown to an ISO time: "4:07", "1 h 05 min", or "starting…" once it has passed. */
export function countdownText(iso: string, now = Date.now()): string {
  const left = (new Date(iso).getTime() - now) / 1000;
  if (left <= 0) return 'starting…';
  const mm = Math.floor(left / 60),
    ss = Math.floor(left % 60);
  return mm >= 60 ? fmtSpan(left) : `${mm}:${String(ss).padStart(2, '0')}`;
}

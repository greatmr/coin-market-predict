import { HOUR_MS } from "../common/time.js";

/** Price over the last three days from stored hourly snapshots (gaps are never filled). */
export interface ThreeDay {
  /** Price now ÷ the earliest stored snapshot inside the window − 1. */
  change: number | null;
  high: number | null;
  low: number | null;
  fromPrice: number | null;
  fromSlot: string | null;
  /** Hours between the earliest point used and now (72 when three full days are stored). */
  spanHours: number;
  /** Hourly snapshots inside the window. */
  points: number;
}

export function threeDayStats(points: Array<{ slotTime: Date; price: number | null }>, slot: Date, hours = 72): ThreeDay {
  const end = slot.getTime();
  const from = end - hours * HOUR_MS;
  const win = points
    .filter((p): p is { slotTime: Date; price: number } => p.price !== null && Number.isFinite(p.price) && p.price > 0 && p.slotTime.getTime() >= from && p.slotTime.getTime() <= end)
    .sort((a, b) => a.slotTime.getTime() - b.slotTime.getTime());
  const cur = win.find((p) => p.slotTime.getTime() === end);
  const first = win[0];
  const prices = win.map((p) => p.price);
  if (!cur || !first || first === cur) {
    return { change: null, high: prices.length ? Math.max(...prices) : null, low: prices.length ? Math.min(...prices) : null, fromPrice: null, fromSlot: null, spanHours: 0, points: win.length };
  }
  return {
    change: cur.price / first.price - 1,
    high: Math.max(...prices),
    low: Math.min(...prices),
    fromPrice: first.price,
    fromSlot: first.slotTime.toISOString(),
    spanHours: Math.round((end - first.slotTime.getTime()) / HOUR_MS),
    points: win.length,
  };
}

/** Volume / market cap now against the coin's own six-month daily baseline (VMC brief). */
export interface VmcContext {
  /** Rolling 24h volume ÷ circulating market cap at this slot. */
  currentRatio: number | null;
  /** Arithmetic mean of completed daily ratios over six months. */
  baselineMean: number | null;
  /** currentRatio ÷ baselineMean (descriptive). */
  multiple: number | null;
  baselineStatus: string | null;
  baselineValidDays: number | null;
  baselineWindow: string | null;
}

export function vmcContext(
  currentRatio: number | null,
  baseline: { meanRatio: number | null; status: string; validDays: number; windowStart: string; windowEnd: string } | null,
): VmcContext {
  const mean = baseline?.meanRatio ?? null;
  return {
    currentRatio,
    baselineMean: mean,
    multiple: currentRatio !== null && mean !== null && mean > 0 ? currentRatio / mean : null,
    baselineStatus: baseline?.status ?? null,
    baselineValidDays: baseline?.validDays ?? null,
    baselineWindow: baseline ? `${baseline.windowStart}..${baseline.windowEnd}` : null,
  };
}

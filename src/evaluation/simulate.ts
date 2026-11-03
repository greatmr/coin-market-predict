import { HOUR_MS } from "../common/time.js";

/** One hourly observation after the signal. high/low only when a source supplies bars. */
export interface Observation {
  slotTime: Date;
  price: number | null;
  high?: number | null;
  low?: number | null;
  isStale?: boolean;
}

export interface ScenarioParams {
  signalSlot: Date;
  entryTriggerPrice: number;
  stopPct: number;
  targetPct: number;
  trailActivatePct: number;
  trailPct: number;
  maxHoldHours: number;
  signalExpiresAt: Date;
  feeBps: number;
  slippageBps: number;
  /** Hours without a usable observation after which an open position is closed as data_gap. */
  maxGapHours?: number;
}

export interface SimResult {
  status: "pending_entry" | "open" | "closed" | "expired";
  entryAt: Date | null;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  highWaterPrice: number | null;
  exitAt: Date | null;
  exitPrice: number | null;
  exitReason: "target" | "stop" | "trailing_stop" | "max_hold" | "expired_no_entry" | "data_gap" | null;
  grossReturn: number | null;
  netReturn: number | null;
  maxAdverseExcursion: number | null;
  ambiguousOrdering: boolean;
  notes: string[];
}

/**
 * Deterministic paper-trade simulation on hourly observations, strictly in time order and only
 * using observations after the signal slot (no look-ahead). Execution assumptions:
 *  - entry at the first observation whose price ≥ trigger, filled at that price + slippage;
 *  - stop/target/trailing evaluated at observations only; a gap through the stop exits at the
 *    observed price (worse than the stop), a target exits at the target price (never better);
 *  - with high/low bars, if both stop and target fall inside one bar the stop is assumed first;
 *  - fees charged on entry and exit.
 */
export function simulatePosition(p: ScenarioParams, obsAsc: Observation[], asOf: Date): SimResult {
  const slip = p.slippageBps / 10_000;
  const fee = p.feeBps / 10_000;
  const notes: string[] = ["hourly observations: intrahour path unobserved"];
  const base: SimResult = {
    status: "pending_entry",
    entryAt: null,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    highWaterPrice: null,
    exitAt: null,
    exitPrice: null,
    exitReason: null,
    grossReturn: null,
    netReturn: null,
    maxAdverseExcursion: null,
    ambiguousOrdering: false,
    notes,
  };
  const obs = obsAsc.filter((o) => o.slotTime > p.signalSlot && o.slotTime <= asOf);
  let r = { ...base };
  let entryFill = 0;
  let lastUsable: Observation | null = null;

  const close = (o: Observation, rawExit: number, reason: NonNullable<SimResult["exitReason"]>) => {
    const fill = rawExit * (1 - slip);
    const gross = fill / entryFill - 1;
    r = { ...r, status: "closed", exitAt: o.slotTime, exitPrice: fill, exitReason: reason, grossReturn: gross, netReturn: gross - 2 * fee };
  };

  for (const o of obs) {
    const usable = o.price !== null && !o.isStale;
    if (r.status === "pending_entry") {
      if (o.slotTime > p.signalExpiresAt) break;
      if (!usable) continue;
      const touched = (o.high ?? o.price!) >= p.entryTriggerPrice;
      if (touched) {
        const raw = Math.max(p.entryTriggerPrice, o.high == null ? o.price! : p.entryTriggerPrice);
        entryFill = raw * (1 + slip);
        r = {
          ...r,
          status: "open",
          entryAt: o.slotTime,
          entryPrice: entryFill,
          stopPrice: entryFill * (1 - p.stopPct),
          targetPrice: entryFill * (1 + p.targetPct),
          highWaterPrice: o.price!,
          maxAdverseExcursion: 0,
        };
        lastUsable = o;
      }
      continue;
    }
    if (r.status !== "open") break;

    if (!usable) {
      if (lastUsable && (o.slotTime.getTime() - lastUsable.slotTime.getTime()) / HOUR_MS > (p.maxGapHours ?? 3)) {
        close(lastUsable, lastUsable.price!, "data_gap");
        notes.push(`closed at last usable observation after gap > ${p.maxGapHours ?? 3}h (possible delisting/outage)`);
        break;
      }
      continue;
    }
    lastUsable = o;
    const low = o.low ?? o.price!;
    const high = o.high ?? o.price!;
    const mae = low / entryFill - 1;
    r.maxAdverseExcursion = Math.min(r.maxAdverseExcursion ?? 0, mae);
    const trailActive = (r.highWaterPrice ?? 0) >= entryFill * (1 + p.trailActivatePct);
    const trailStop = trailActive ? r.highWaterPrice! * (1 - p.trailPct) : -Infinity;
    const effStop = Math.max(r.stopPrice!, trailStop);
    const hitStop = low <= effStop;
    const hitTarget = high >= r.targetPrice!;
    if (hitStop && hitTarget) {
      r.ambiguousOrdering = true;
      notes.push("stop and target both inside one bar: stop assumed first (conservative)");
    }
    if (hitStop) {
      close(o, Math.min(effStop, o.price!), trailActive && trailStop >= r.stopPrice! ? "trailing_stop" : "stop");
      break;
    }
    if (hitTarget) {
      close(o, r.targetPrice!, "target");
      break;
    }
    r.highWaterPrice = Math.max(r.highWaterPrice ?? 0, high);
    if (o.slotTime.getTime() - r.entryAt!.getTime() >= p.maxHoldHours * HOUR_MS) {
      close(o, o.price!, "max_hold");
      break;
    }
  }
  if (r.status === "pending_entry" && asOf > p.signalExpiresAt) {
    r = { ...r, status: "expired", exitReason: "expired_no_entry" };
  }
  return r;
}

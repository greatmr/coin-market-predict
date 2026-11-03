import { addHours } from "../common/time.js";
import type { Classification } from "./screen.js";
import type { StrategyParams } from "./strategy.js";

/** Conditional paper-trading scenario computed deterministically from strategy parameters. */
export interface PaperScenario {
  referencePrice: number;
  entryTriggerPrice: number;
  entryRule: string;
  stopPrice: number;
  stopRule: string;
  targetPrice: number;
  targetRule: string;
  trailingRule: string;
  trailActivatePct: number;
  trailPct: number;
  maxHoldHours: number;
  signalExpiresAt: string;
  feeBps: number;
  slippageBps: number;
  liquidityNote: string;
  executionAssumption: string;
}

export function buildScenario(input: {
  referencePrice: number;
  slotTime: Date;
  classification: Classification;
  params: StrategyParams;
  feeBps: number;
  slippageBps: number;
  estSlippagePct: number | null;
}): PaperScenario {
  const p = input.params;
  const breakout = input.classification === "move_underway" ? p.entryBreakoutPct * 2 : p.entryBreakoutPct;
  const entry = input.referencePrice * (1 + breakout);
  const stop = entry * (1 - p.stopPct);
  const target = entry * (1 + p.targetPct);
  const expires = addHours(input.slotTime, p.entryExpiryHours);
  const slippageBps =
    input.estSlippagePct !== null ? Math.max(input.slippageBps, Math.round(input.estSlippagePct * 10_000)) : input.slippageBps;
  return {
    referencePrice: input.referencePrice,
    entryTriggerPrice: entry,
    entryRule: `Enter only if an hourly snapshot prints ≥ ${fmt(entry)} (+${pct(breakout)} vs reference) before ${expires.toISOString()}`,
    stopPrice: stop,
    stopRule: `Invalidate if an hourly snapshot prints ≤ ${fmt(stop)} (−${pct(p.stopPct)} from entry)`,
    targetPrice: target,
    targetRule: `Take profit at ≥ ${fmt(target)} (+${pct(p.targetPct)} from entry)`,
    trailingRule: `After +${pct(p.trailActivatePct)}, exit if price falls ${pct(p.trailPct)} below the highest hourly snapshot`,
    trailActivatePct: p.trailActivatePct,
    trailPct: p.trailPct,
    maxHoldHours: p.maxHoldHours,
    signalExpiresAt: expires.toISOString(),
    feeBps: input.feeBps,
    slippageBps,
    liquidityNote:
      input.estSlippagePct !== null
        ? `Slippage raised to ${slippageBps} bps from depth-based estimate`
        : "No order-book depth from source; flat slippage assumption only",
    executionAssumption:
      "Hourly snapshots only: fills assumed at the first qualifying snapshot price plus slippage. Intrahour highs/lows are unobserved; when a stop and target could both have been crossed between snapshots the stop is assumed first.",
  };
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

export function fmt(x: number): string {
  if (x >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (x >= 1) return x.toFixed(3);
  if (x >= 0.01) return x.toFixed(5);
  return x.toPrecision(4);
}

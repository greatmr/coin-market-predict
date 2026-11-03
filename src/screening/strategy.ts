import { FEATURE_SET_VERSION } from "../features/registry.js";

/**
 * Versioned research target. A signal "hits" when, within `horizonHours` after entry and
 * observed at hourly snapshots, the asset gains at least `minReturn`, beats the benchmark by
 * `minExcessReturn`, and never falls below `maxAdverseExcursion` before reaching the target.
 */
export interface ResearchTarget {
  version: string;
  horizonHours: number;
  minReturn: number;
  benchmark: "btc" | "market_median";
  minExcessReturn: number;
  maxAdverseExcursion: number;
  observation: "hourly_snapshots";
}

export interface StrategyParams {
  version: string;
  description: string;
  featureSetVersion: string;
  // Eligibility
  minVolume24hUsd: number;
  minMarketCapUsd: number;
  microCapUsd: number;
  // Classification thresholds (fractions)
  overextendedRet2h: number;
  overextendedChange24h: number;
  underwayRet2h: number;
  advanceMinRet2h: number;
  advanceMinVolumeBuild: number;
  marketRallyRet2h: number;
  minRelativeStrength: number;
  gradualMaxAccel: number;
  minShortlistScore: number;
  // Paper scenario
  entryBreakoutPct: number;
  entryExpiryHours: number;
  stopPct: number;
  targetPct: number;
  trailActivatePct: number;
  trailPct: number;
  maxHoldHours: number;
  target: ResearchTarget;
}

export const RESEARCH_TARGET_V1: ResearchTarget = {
  version: "target-1",
  horizonHours: 24,
  minReturn: 0.15,
  benchmark: "market_median",
  minExcessReturn: 0.1,
  maxAdverseExcursion: -0.07,
  observation: "hourly_snapshots",
};

export function defaultStrategy(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return {
    version: "surge-screen-1",
    description:
      "Heuristic surge screen: volume build + accelerating price + relative strength, excluding stablecoins, wrapped exposure, illiquid, stale, market-wide and overextended moves.",
    featureSetVersion: FEATURE_SET_VERSION,
    minVolume24hUsd: 250_000,
    minMarketCapUsd: 5_000_000,
    microCapUsd: 20_000_000,
    overextendedRet2h: 0.25,
    overextendedChange24h: 0.6,
    underwayRet2h: 0.08,
    advanceMinRet2h: 0.005,
    advanceMinVolumeBuild: 0.15,
    marketRallyRet2h: 0.02,
    minRelativeStrength: 0.01,
    gradualMaxAccel: 0.003,
    minShortlistScore: 35,
    entryBreakoutPct: 0.01,
    entryExpiryHours: 6,
    stopPct: 0.07,
    targetPct: 0.15,
    trailActivatePct: 0.08,
    trailPct: 0.05,
    maxHoldHours: 24,
    target: RESEARCH_TARGET_V1,
    ...overrides,
  };
}

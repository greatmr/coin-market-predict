import type { FeatureVector, MarketContext } from "../features/compute.js";
import type { StrategyParams } from "./strategy.js";

export type Classification =
  | "advance_candidate" // early: volume building, price starting to accelerate, outperforming
  | "move_underway" // detection of a move already in progress (not an advance signal)
  | "gradual_trend" // steady appreciation, not a surge
  | "market_wide" // moving with a broad rally, little idiosyncratic strength
  | "overextended" // already moved too far to treat as an opportunity
  | "none";

export interface ScreenInput {
  assetId: string;
  symbol: string;
  name: string;
  assetClass: string;
  isBenchmark: boolean;
  hasCurrentSnapshot: boolean;
  latest: {
    price: number | null;
    marketCap: number | null;
    fullyDilutedValuation: number | null;
    volumeRolling24h: number | null;
    isStale: boolean;
    completeness: number;
    marketCapProvenance: string;
    qualityFlags: string[];
  } | null;
  features: FeatureVector;
}

export interface ScreenOutput {
  assetId: string;
  eligible: boolean;
  exclusionReasons: string[];
  classification: Classification;
  heuristicScore: number;
  components: Record<string, number>;
  riskFlags: string[];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const EXCLUDED_CLASSES = new Set(["stablecoin", "wrapped", "bridged", "staked"]);

export function screenAsset(input: ScreenInput, market: MarketContext, p: StrategyParams): ScreenOutput {
  const reasons: string[] = [];
  const risk: string[] = [];
  const f = input.features.values;
  const latest = input.latest;

  if (EXCLUDED_CLASSES.has(input.assetClass)) reasons.push(`excluded_class:${input.assetClass}`);
  if (input.isBenchmark) reasons.push("benchmark_reference");
  if (!input.hasCurrentSnapshot || !latest) reasons.push("no_current_snapshot");
  if (latest?.isStale) reasons.push("stale_observation");
  if (latest && (latest.price === null || latest.volumeRolling24h === null)) reasons.push("incomplete_data");
  if (latest && latest.volumeRolling24h !== null && latest.volumeRolling24h < p.minVolume24hUsd) reasons.push("illiquid_volume");
  if (latest && latest.marketCap === null) reasons.push("market_cap_unavailable");
  if (latest && latest.marketCap !== null && latest.marketCap < p.minMarketCapUsd) reasons.push("below_min_market_cap");
  if (input.features.warmupState === "warming_up") reasons.push("warming_up");

  // Risk flags (do not exclude on their own; they reduce the score and inform reviewers).
  const vm = f.vol_mcap ?? null;
  const r1 = f.ret_1h ?? null;
  const r2 = f.ret_2h ?? null;
  const acc = f.accel_1h ?? null;
  const vchg = f.vol24_change_2h ?? null;
  const rsm = f.rs_market_2h ?? null;
  if (vm !== null && vm > 1) risk.push("volume_exceeds_market_cap");
  if (latest?.marketCap != null && latest.marketCap < p.microCapUsd) risk.push("micro_cap");
  if (latest?.marketCapProvenance === "calculated_from_circulating_supply") risk.push("market_cap_calculated");
  if (latest?.fullyDilutedValuation && latest.marketCap && latest.fullyDilutedValuation / latest.marketCap > 5) risk.push("large_fdv_overhang");
  if (r1 !== null && Math.abs(r1) > 0.15) risk.push("extreme_1h_move");
  if (r2 !== null && r2 > 0.05 && vchg !== null && vchg < 0) risk.push("price_up_without_volume");
  if ((f.provider_change_1h_gap ?? 0) > 0.02) risk.push("provider_timing_mismatch");
  if (f.spread_pct === null || f.spread_pct === undefined) risk.push("no_liquidity_data");
  if (input.features.warmupState !== "full") risk.push("thin_history");
  for (const q of latest?.qualityFlags ?? []) if (q === "volume_exceeds_2x_market_cap") risk.push("possible_wash_trading");

  const eligible = reasons.length === 0;

  // Classification (deterministic, versioned with the strategy).
  let classification: Classification = "none";
  const ch24 = f.provider_change_24h ?? null;
  if (eligible && r2 !== null) {
    if (r2 >= p.overextendedRet2h || (ch24 !== null && ch24 >= p.overextendedChange24h)) classification = "overextended";
    else if (
      market.marketMedianRet2h !== null &&
      market.marketMedianRet2h >= p.marketRallyRet2h &&
      (rsm === null || rsm < p.minRelativeStrength)
    )
      classification = "market_wide";
    else if (r2 >= p.underwayRet2h) classification = "move_underway";
    else if (
      vchg !== null &&
      vchg >= p.advanceMinVolumeBuild &&
      r2 >= p.advanceMinRet2h &&
      acc !== null &&
      acc > 0 &&
      (rsm === null || rsm > 0)
    )
      classification = "advance_candidate";
    else if (r1 !== null && r1 > 0 && r2 > 0 && acc !== null && Math.abs(acc) <= p.gradualMaxAccel && (vchg === null || vchg < p.advanceMinVolumeBuild))
      classification = "gradual_trend";
    if (classification === "gradual_trend" && (f.trend_persistence_12h ?? 1) < 0.6) classification = "none";
  }

  // Heuristic score 0..100 — a ranking aid, NOT a probability.
  const components: Record<string, number> = {
    volume_build: clamp01((vchg ?? 0) / 0.6),
    acceleration: clamp01((acc ?? 0) / 0.02),
    relative_strength: clamp01((rsm ?? 0) / 0.06),
    momentum: clamp01((r2 ?? 0) / p.underwayRet2h),
    turnover: vm === null ? 0 : vm > 1 ? 0 : clamp01((vm - 0.02) / 0.3),
    statistical: clamp01(((f.ret_zscore_1h ?? 0) / 4 + ((f.breakout_24h ?? -1) > 0 ? 0.5 : 0) + (f.vol24_zscore_72h ?? 0) / 6) / 1.5),
  };
  const weights: Record<string, number> = {
    volume_build: 0.28,
    acceleration: 0.22,
    relative_strength: 0.2,
    momentum: 0.12,
    turnover: 0.08,
    statistical: 0.1,
  };
  let score = 0;
  for (const [k, w] of Object.entries(weights)) score += (components[k] ?? 0) * w * 100;
  const penalties =
    risk.filter((r) => ["volume_exceeds_market_cap", "possible_wash_trading", "extreme_1h_move", "price_up_without_volume", "provider_timing_mismatch"].includes(r)).length * 12 +
    risk.filter((r) => ["micro_cap", "market_cap_calculated", "large_fdv_overhang"].includes(r)).length * 5 +
    (latest ? (1 - latest.completeness) * 20 : 20);
  components.penalty = penalties;
  if (classification === "overextended" || classification === "market_wide") score *= 0.5;
  score = Math.max(0, Math.min(100, score - penalties));

  return {
    assetId: input.assetId,
    eligible,
    exclusionReasons: reasons,
    classification,
    heuristicScore: Math.round(score * 1000) / 1000,
    components,
    riskFlags: [...new Set(risk)],
  };
}

export const SHORTLIST_CLASSES: ReadonlySet<Classification> = new Set(["advance_candidate", "move_underway"]);

/** Rank eligible outputs by score and mark the configured shortlist. */
export function rankAndShortlist(outputs: ScreenOutput[], size: number, minScore: number) {
  const ranked = outputs
    .filter((o) => o.eligible)
    .sort((a, b) => b.heuristicScore - a.heuristicScore || a.assetId.localeCompare(b.assetId));
  const rank = new Map<string, number>();
  ranked.forEach((o, i) => rank.set(o.assetId, i + 1));
  const shortlist = new Set(
    ranked
      .filter((o) => SHORTLIST_CLASSES.has(o.classification) && o.heuristicScore >= minScore)
      .slice(0, size)
      .map((o) => o.assetId),
  );
  return outputs.map((o) => ({ ...o, rank: rank.get(o.assetId) ?? null, shortlisted: shortlist.has(o.assetId) }));
}

/**
 * Versioned feature definitions (feature set "fs-1").
 * Each feature declares the consecutive hourly snapshots and fields it needs. When the
 * requirement is not met the feature is NULL with an explicit reason; it is never estimated.
 * Changing any formula requires a new FEATURE_SET_VERSION.
 */

export const FEATURE_SET_VERSION = "fs-1";

export type FeatureKind = "heuristic" | "statistical" | "provider_reported" | "liquidity";

export interface FeatureDefinition {
  name: string;
  description: string;
  kind: FeatureKind;
  /** Consecutive non-stale hourly snapshots ending at t (t counts as 1). */
  minSnapshots: number;
  requiredFields: string[];
  /** Needs market/benchmark context computed across the universe. */
  needsMarketContext?: boolean;
}

export const FEATURES: readonly FeatureDefinition[] = [
  { name: "ret_1h", kind: "heuristic", minSnapshots: 2, requiredFields: ["price"], description: "Price return t-1h → t." },
  { name: "ret_2h", kind: "heuristic", minSnapshots: 3, requiredFields: ["price"], description: "Price return t-2h → t." },
  { name: "accel_1h", kind: "heuristic", minSnapshots: 3, requiredFields: ["price"], description: "ret_1h(t) − ret_1h(t-1): positive when the move is speeding up." },
  {
    name: "vol24_change_2h",
    kind: "heuristic",
    minSnapshots: 3,
    requiredFields: ["volumeRolling24h"],
    description: "Relative change of the provider's ROLLING 24h volume between t-2h and t. This is a change in a rolling total, not hourly volume.",
  },
  { name: "vol_mcap", kind: "heuristic", minSnapshots: 1, requiredFields: ["volumeRolling24h", "marketCap"], description: "Rolling 24h volume / circulating market cap." },
  { name: "rs_btc_1h", kind: "heuristic", minSnapshots: 2, requiredFields: ["price"], needsMarketContext: true, description: "ret_1h minus BTC ret_1h." },
  { name: "rs_eth_1h", kind: "heuristic", minSnapshots: 2, requiredFields: ["price"], needsMarketContext: true, description: "ret_1h minus ETH ret_1h." },
  { name: "rs_market_2h", kind: "heuristic", minSnapshots: 3, requiredFields: ["price"], needsMarketContext: true, description: "ret_2h minus median ret_2h of the eligible universe." },
  { name: "provider_change_24h", kind: "provider_reported", minSnapshots: 1, requiredFields: ["providerChangePct24h"], description: "Provider-reported 24h price change (fraction). Labeled provider data, not computed by us." },
  { name: "provider_change_1h_gap", kind: "heuristic", minSnapshots: 2, requiredFields: ["price", "providerChangePct1h"], description: "Absolute difference between our ret_1h and provider 1h change; large values suggest timing/data inconsistency." },
  { name: "trend_persistence_12h", kind: "statistical", minSnapshots: 13, requiredFields: ["price"], description: "Share of positive hourly returns over the last 12h (steady appreciation is high and smooth)." },
  { name: "realized_vol_24h", kind: "statistical", minSnapshots: 25, requiredFields: ["price"], description: "Std. dev. of hourly log returns over 24h." },
  { name: "ret_zscore_1h", kind: "statistical", minSnapshots: 25, requiredFields: ["price"], description: "ret_1h divided by realized_vol_24h." },
  { name: "breakout_24h", kind: "statistical", minSnapshots: 25, requiredFields: ["price"], description: "Price relative to the prior 24h maximum (positive = new 24h high)." },
  {
    name: "vol24_zscore_72h",
    kind: "statistical",
    minSnapshots: 73,
    requiredFields: ["volumeRolling24h"],
    description: "Z-score of log rolling-24h volume vs the prior 72 snapshots (overlapping windows are autocorrelated; treat as a heuristic anomaly flag).",
  },
  { name: "spread_pct", kind: "liquidity", minSnapshots: 1, requiredFields: ["bidAskSpreadPct"], description: "Bid/ask spread percentage when the source provides it." },
  {
    name: "est_slippage_pct",
    kind: "liquidity",
    minSnapshots: 1,
    requiredFields: ["depthPlus2PctUsd"],
    description: "Linear estimate of buy slippage for the configured paper notional using +2% depth. Rough estimate.",
  },
];

export const FEATURE_NAMES = FEATURES.map((f) => f.name);
export const STATISTICAL_WARMUP_SNAPSHOTS = Math.max(...FEATURES.filter((f) => f.kind === "statistical").map((f) => f.minSnapshots));

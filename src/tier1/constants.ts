/**
 * Two-Tier VMC strategy, Tier 1 constants. Every value below is stated in the PDF
 * (docs/strategy-two-tier-vmc.md); changing one is a ruleset change and must bump RULESET_VERSION.
 */
export const RULESET_VERSION = "vmc-tier1-1";

export const RULES = {
  /** Current CMC rank, inclusive (p.3, p.9). */
  rankMin: 101,
  rankMax: 1200,
  /** USD circulating market cap, inclusive (p.3, p.9). */
  minMarketCapUsd: "15000000",
  /** 60 × 24 hours since CMC date_added; exactly 60 days qualifies (p.9). */
  minListingAgeMs: 60 * 24 * 3_600_000,
  /** multiple_N ≥ 1.5 → YES; exactly 1.5 is YES (p.13). */
  passMultiple: "1.5",
  /** Window means: 3/7/30 are compared, 14 is context only (p.5, p.6, p.14). */
  windows: [3, 7, 14, 30] as const,
  passWindows: [3, 7, 30] as const,
  /** Completed daily rows kept for the longest window (p.5, p.11). */
  requiredDailyRows: 30,
} as const;

export type WindowDays = (typeof RULES.windows)[number];
export type PassWindow = (typeof RULES.passWindows)[number];
export type PassStatus = "YES" | "NO" | "N/A";
export type EligibilityStatus = "ELIGIBLE" | "EXCLUDED" | "NEEDS_REVIEW";
export type CurrentStatus = "OK" | "STALE" | "TIMESTAMP_UNVERIFIED" | "MISMATCHED" | "MISSING" | "INVALID";
export type LbankStatus = "VERIFIED" | "PAIR_LISTED_UNVERIFIED" | "NOT_LISTED" | "NOT_TRADABLE" | "UNKNOWN";
export type QueueStatus = "PUBLISHED" | "WITHHELD_INCOMPLETE_BATCH" | "WITHHELD_LBANK_UNAVAILABLE" | "EMPTY";
export type BatchStatus = "COMPLETE" | "INCOMPLETE" | "FAILED";

/** Reason codes (stable strings: they appear in exports, the API and tests). */
export const REASON = {
  // window means
  dailyRowMissing: "DAILY_ROW_MISSING",
  dailyRowInvalid: "DAILY_ROW_INVALID",
  zeroBaseline: "ZERO_BASELINE",
  notEvaluated: "NOT_EVALUATED_EXCLUDED",
  // current observation
  currentMissing: "CURRENT_MISSING",
  currentStale: "CURRENT_STALE",
  timestampMissing: "TIMESTAMP_UNVERIFIED",
  timestampFuture: "TIMESTAMP_IN_FUTURE",
  mismatched: "MISMATCHED_OBSERVATION",
  capInvalid: "CURRENT_CAP_INVALID",
  volumeInvalid: "CURRENT_VOLUME_INVALID",
  // eligibility
  rankOutOfRange: "RANK_OUT_OF_RANGE",
  rankMissing: "RANK_MISSING",
  rankAmbiguous: "RANK_AMBIGUOUS",
  capBelowMin: "MARKET_CAP_BELOW_MIN",
  capMissing: "MARKET_CAP_MISSING",
  ageBelowMin: "LISTING_AGE_BELOW_60D",
  dateAddedMissing: "DATE_ADDED_MISSING",
  dateAddedFuture: "DATE_ADDED_AFTER_SCAN",
  stablecoin: "STABLECOIN",
  tokenized: "TOKENIZED_ASSET",
  classAmbiguous: "CLASS_AMBIGUOUS",
  noLbankPair: "NO_LBANK_SPOT_PAIR",
  lbankNotTradable: "LBANK_NOT_TRADABLE",
  lbankUnverified: "LBANK_PAIR_UNVERIFIED",
  lbankUnknown: "LBANK_STATUS_UNKNOWN",
} as const;

/** Future provider timestamps within this tolerance are clock skew, beyond it unverified (A3). */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Exchange slug of LBank in CMC venue data. */
export const LBANK = "lbank";

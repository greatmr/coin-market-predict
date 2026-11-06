/**
 * Two-Tier VMC strategy constants. Every value below is stated in the PDF
 * (docs/strategy-two-tier-vmc.md); changing one is a ruleset change and must bump RULESET_VERSION.
 * The status lists are the value sets of the matching PostgreSQL enum types (migration M005):
 * adding a value needs a migration as well.
 */
export const RULESET_VERSION = 'vmc-tier1-1';

export const STRATEGY_NAME =
  'Two-Tier VMC strategy (Tier 1 CMC screen → Tier 2 human chart review)';

export const RULES = {
  /** Current CMC rank, inclusive (p.3, p.9). */
  rankMin: 101,
  rankMax: 1200,
  /** USD circulating market cap, inclusive (p.3, p.9). */
  minMarketCapUsd: '15000000',
  /** 60 × 24 hours since CMC date_added; exactly 60 days qualifies (p.9). */
  minListingAgeMs: 60 * 24 * 3_600_000,
  /** multiple_N ≥ 1.5 → YES; exactly 1.5 is YES (p.13). */
  passMultiple: '1.5',
  /** Window means: 3/7/30 are compared, 14 is context only (p.5, p.6, p.14). */
  windows: [3, 7, 14, 30] as const,
  passWindows: [3, 7, 30] as const,
  /** Completed daily rows kept for the longest window (p.5, p.11). */
  requiredDailyRows: 30,
} as const;

export type WindowDays = (typeof RULES.windows)[number];
export type PassWindow = (typeof RULES.passWindows)[number];

export const PASS_STATUSES = ['YES', 'NO', 'N/A'] as const;
export type PassStatus = (typeof PASS_STATUSES)[number];

export const ELIGIBILITY_STATUSES = ['ELIGIBLE', 'EXCLUDED', 'NEEDS_REVIEW'] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export const CURRENT_STATUSES = [
  'OK',
  'STALE',
  'TIMESTAMP_UNVERIFIED',
  'MISMATCHED',
  'MISSING',
  'INVALID',
] as const;
export type CurrentStatus = (typeof CURRENT_STATUSES)[number];

export const LBANK_STATUSES = [
  'VERIFIED',
  'PAIR_LISTED_UNVERIFIED',
  'NOT_LISTED',
  'NOT_TRADABLE',
  'UNKNOWN',
] as const;
export type LbankStatus = (typeof LBANK_STATUSES)[number];

export const QUEUE_STATUSES = [
  'PUBLISHED',
  'WITHHELD_INCOMPLETE_BATCH',
  'WITHHELD_LBANK_UNAVAILABLE',
  'EMPTY',
] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** Crawl batches and venue crawls (PDF p.16, p.18). */
export const CRAWL_STATUSES = ['COMPLETE', 'INCOMPLETE', 'FAILED'] as const;
export type BatchStatus = (typeof CRAWL_STATUSES)[number];

/** Tier 1 asset class after tags and overrides (p.9). */
export const TIER1_CLASSES = ['regular', 'stablecoin', 'tokenized', 'ambiguous'] as const;
export type Tier1Class = (typeof TIER1_CLASSES)[number];

/** Human LBank venue decisions (p.10, A7, A9). */
export const VENUE_DECISION_KINDS = [
  'VERIFIED_TRADABLE',
  'NOT_TRADABLE',
  'MAPPING_CONFIRMED',
  'MAPPING_REJECTED',
] as const;
export type DecisionKind = (typeof VENUE_DECISION_KINDS)[number];

/** Saved evidence tasks for ambiguous LBank base tickers (p.10). */
export const MAPPING_TASK_KINDS = ['SYMBOL_MISMATCH', 'TICKER_MULTIPLE_IDS'] as const;
export type MappingTaskKind = (typeof MAPPING_TASK_KINDS)[number];

/** Reason codes (stable strings: they appear in exports, the API and tests). */
export const REASON = {
  // window means
  dailyRowMissing: 'DAILY_ROW_MISSING',
  dailyRowInvalid: 'DAILY_ROW_INVALID',
  zeroBaseline: 'ZERO_BASELINE',
  notEvaluated: 'NOT_EVALUATED_EXCLUDED',
  // current observation
  currentMissing: 'CURRENT_MISSING',
  currentStale: 'CURRENT_STALE',
  timestampMissing: 'TIMESTAMP_UNVERIFIED',
  timestampFuture: 'TIMESTAMP_IN_FUTURE',
  mismatched: 'MISMATCHED_OBSERVATION',
  capInvalid: 'CURRENT_CAP_INVALID',
  volumeInvalid: 'CURRENT_VOLUME_INVALID',
  // eligibility
  rankOutOfRange: 'RANK_OUT_OF_RANGE',
  rankMissing: 'RANK_MISSING',
  rankAmbiguous: 'RANK_AMBIGUOUS',
  capBelowMin: 'MARKET_CAP_BELOW_MIN',
  capMissing: 'MARKET_CAP_MISSING',
  ageBelowMin: 'LISTING_AGE_BELOW_60D',
  dateAddedMissing: 'DATE_ADDED_MISSING',
  dateAddedFuture: 'DATE_ADDED_AFTER_SCAN',
  stablecoin: 'STABLECOIN',
  tokenized: 'TOKENIZED_ASSET',
  classAmbiguous: 'CLASS_AMBIGUOUS',
  noLbankPair: 'NO_LBANK_SPOT_PAIR',
  lbankNotTradable: 'LBANK_NOT_TRADABLE',
  lbankUnverified: 'LBANK_PAIR_UNVERIFIED',
  lbankUnknown: 'LBANK_STATUS_UNKNOWN',
} as const;

/** Future provider timestamps within this tolerance are clock skew, beyond it unverified (A3). */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Exchange slug of LBank in CMC venue data. */
export const LBANK = 'lbank';

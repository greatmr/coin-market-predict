/**
 * Star Event Forward Test (docs/forward-test.md): an add-on to the Tier 1 scanner that records the
 * first priced 1/2/3-star detection per (CMC id, UTC date, star count) and measures the highest
 * future High until the end of the UTC day containing detected_at + 168 h. It is a descriptive
 * measurement, never a trade, a signal or realized P/L, and it does not change any Tier 1 rule.
 *
 * Changing a rule below or in `forward-rules.ts` is a forward-test rules change: bump
 * FORWARD_RULES_VERSION and update docs/forward-test.md. The value sets are PostgreSQL enum types
 * (migration M008): adding a value needs a migration as well.
 */
export const FORWARD_RULES_VERSION = 'star-forward-1';

/** Nominal horizon: detected_at + 168 hours (owner decision, PDF p.2, p.6). */
export const HORIZON_HOURS = 168;
export const HORIZON_MS = HORIZON_HOURS * 3_600_000;

/** Days after evaluation_end during which missing daily rows are still requested from the source. */
export const MISSING_DATA_RETRY_DAYS = 3;

/**
 * Time bound of the update's own daily-row requests, so the hourly run that carries the daily
 * update never runs into the next hour; what is left is fetched at the retry.
 */
export const FETCH_MAX_MINUTES = 10;

/** OPEN → TRACKING → AWAITING_FINAL_DAY → FINAL, or INCOMPLETE (PDF p.7). */
export const FORWARD_EVENT_STATUSES = [
  'OPEN',
  'TRACKING',
  'AWAITING_FINAL_DAY',
  'FINAL',
  'INCOMPLETE',
] as const;
export type ForwardEventStatus = (typeof FORWARD_EVENT_STATUSES)[number];

/** Statuses still followed by the daily update (the event's "open" set on the watchlist). */
export const ACTIVE_EVENT_STATUSES: readonly ForwardEventStatus[] = [
  'OPEN',
  'TRACKING',
  'AWAITING_FINAL_DAY',
];

/**
 * How one daily High counts for one event (PDF p.6):
 *  - FULL_DAY: a completed UTC day entirely inside [detected_at, evaluation_end];
 *  - DAY0_POST_SIGNAL: the signal day's High, proven post-signal by its documented time_high;
 *  - DAY0_UNPROVEN: the signal day's High without that proof — an upper bound of the unknown
 *    post-signal part, never a forward result;
 *  - INVALID: unusable (missing / non-positive High, non-USD quote, not one UTC day).
 */
export const HIGH_ELIGIBILITIES = [
  'FULL_DAY',
  'DAY0_POST_SIGNAL',
  'DAY0_UNPROVEN',
  'INVALID',
] as const;
export type HighEligibility = (typeof HIGH_ELIGIBILITIES)[number];

/** EXACT: final maximum. LOWER_BOUND: running or incomplete maximum. NONE: no eligible High yet. */
export const PEAK_KINDS = ['EXACT', 'LOWER_BOUND', 'NONE'] as const;
export type PeakKind = (typeof PEAK_KINDS)[number];

/** Whether the peak fell after deadline_168h (inside the end-of-day extension), PDF p.8. */
export const EXTENSION_FLAGS = ['TRUE', 'FALSE', 'UNKNOWN'] as const;
export type ExtensionFlag = (typeof EXTENSION_FLAGS)[number];

/** SOURCE_TIME: the source's documented time of the High (minutes on CMC). UTC_DAY: only the day. */
export const TIME_PRECISIONS = ['SOURCE_TIME', 'UTC_DAY'] as const;
export type TimePrecision = (typeof TIME_PRECISIONS)[number];

/** Provisional (window open or final day pending), complete (FINAL) or incomplete. */
export const COVERAGE_STATUSES = ['PROVISIONAL', 'COMPLETE', 'INCOMPLETE'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const FORWARD_UPDATE_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;
export type ForwardUpdateStatus = (typeof FORWARD_UPDATE_STATUSES)[number];

/** Reason codes (stable strings: they appear in the database, exports, the API and tests). */
export const FORWARD_REASON = {
  // trigger (PDF p.3, p.10)
  queueNotPublished: 'QUEUE_NOT_PUBLISHED',
  batchNotComplete: 'BATCH_NOT_COMPLETE',
  batchNotCurrent: 'TRIGGER_BATCH_NOT_CURRENT',
  notInQueue: 'NOT_IN_REVIEW_QUEUE',
  notEligible: 'NOT_ELIGIBLE',
  starsOutOfRange: 'STARS_OUT_OF_RANGE',
  lbankNotVerified: 'LBANK_NOT_VERIFIED',
  cmcIdMissing: 'CMC_ID_MISSING',
  assetIdAmbiguous: 'ASSET_ID_AMBIGUOUS',
  priceMissing: 'PRICE_MISSING',
  priceNotFinite: 'PRICE_NOT_FINITE',
  priceNotPositive: 'PRICE_NOT_POSITIVE',
  quoteNotOk: 'QUOTE_NOT_OK',
  quoteStale: 'QUOTE_STALE',
  sourceTimeMissing: 'SOURCE_TIME_MISSING',
  observedAtMissing: 'OBSERVED_AT_MISSING',
  // Highs and coverage (PDF p.5–7, p.10)
  highMissing: 'HIGH_MISSING',
  highInvalid: 'HIGH_INVALID',
  day0Unresolved: 'DAY0_UNRESOLVED',
  incompleteDay0: 'INCOMPLETE_DAY0',
  finalDayPending: 'FINAL_DAY_PENDING',
  peakTieUnobservedDay0: 'PEAK_TIE_UNOBSERVED_DAY0',
  contractEvidenceChanged: 'CONTRACT_EVIDENCE_CHANGED',
} as const;

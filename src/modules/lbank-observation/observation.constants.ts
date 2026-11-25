/**
 * LBank Spot Price Observation (docs/lbank-spot-observation.md, ADR-0009 and its 2026-11-25
 * addendum): for each CMC star event detected at or after the cutover, the first verified LBank Spot
 * trade at or after the moment the signal was usable (the reference) and the highest and lowest
 * verified LBank Spot trades over exactly [observation_start, observation_start + 168 h). A
 * descriptive observation: no trade, stop, target, fee, funding, leverage or profit is modelled.
 *
 * Changing a rule below or in `observation-rules.ts` / `observation-timing.ts` is a calculation
 * change: bump OBSERVATION_RULES_VERSION (stored on every observation and result) and update the doc.
 * The value sets are PostgreSQL enum types (migrations M015, M016): adding a value needs a migration.
 */
export const OBSERVATION_RULES_VERSION = 'lbank-spot-obs-2';
/** The first rules (candle-OPEN entry from the crawl time): kept on old rows as audit only. */
export const OBSERVATION_RULES_V1 = 'lbank-spot-obs-1';

/** The price source label shown with every number (never CMC). */
export const PRICE_SOURCE =
  'LBank Spot trades (REST /v2/supplement/trades.do), located with 1-minute candles (/v2/kline.do)';
export const PRICE_INTERVAL = 'minute1';

/** Provider row of the LBank public API (its circuit breaker and request budget). */
export const LBANK_SPOT_PROVIDER = 'lbank_spot';

export const MINUTE_MS = 60_000;
export const WINDOW_HOURS = 168;
/** Exactly observation_start + 168 h; no extension to the end of a UTC day. */
export const WINDOW_MS = WINDOW_HOURS * 3_600_000;

/**
 * Candles fetched before the observation start: Spot evidence that the series spans the signal
 * (a bar in the hour before it). Never a price input.
 */
export const SPOT_LOOKBACK_MS = 60 * MINUTE_MS;
/** Window after the start in which a traded minute counts as "trading at the signal" (evidence). */
export const SIGNAL_TRADE_WINDOW_MS = 60 * MINUTE_MS;

/**
 * The API also returns the minute still in progress; a bar is stored only once closed, judged by the
 * response's own server time (`ts`) less this margin (a closed bar was final 1.2 s after its close).
 */
export const CLOSED_BAR_MARGIN_MS = 5_000;

/**
 * After the window ends, every gap (candles, trade checks, the first minutes included) is retried
 * this long before a terminal status: the one retry policy of the observation (ADR-0009).
 */
export const FINALIZE_RETRY_MS = 24 * 3_600_000;

/** An LBank markets list counts as evidence at the signal only when fetched within this of t0. */
export const EVIDENCE_MAX_LAG_MS = 2 * 3_600_000;

/**
 * Review signal only (never a price input, never terminal since rules v2): a reference trade more
 * than this away from the CMC price at detection is flagged for a reviewer. Tested events deviated
 * 0.08–4.6 %.
 */
export const MAPPING_MAX_PRICE_DEVIATION = '0.25';

/** `GET /v2/kline.do` accepts size 1–2000 (2001 → error 10003). */
export const KLINE_MAX_SIZE = 2000;
/** Kline pages fetched for one pair in one run (a full 168 h window is 6 pages). */
export const MAX_PAGES_PER_PAIR_PER_RUN = 8;

/**
 * `GET /v2/supplement/trades.do` accepts size 1–600: 601 and 1000 answer error 10003 (tested live
 * 2026-11-25; the probe's page size). It returns trades strictly AFTER `time` (ms), ascending.
 */
export const TRADES_PAGE_SIZE = 600;
/** Pages read for one minute before its trade list counts as incomplete (36 000 trades). */
export const TRADES_MAX_PAGES_PER_MINUTE = 60;
/** Minutes whose trades are checked for one pair in one run (shared by its observations). */
export const MAX_TRADE_MINUTES_PER_PAIR_PER_RUN = 40;

export const PREFERRED_QUOTE = 'USDT';

export const OBSERVATION_STATUSES = [
  'ACTIVE',
  'FINAL',
  'PARTIAL',
  'DATA_UNAVAILABLE',
  'MAPPING_AMBIGUOUS',
  'ELIGIBILITY_UNKNOWN',
  'NO_TRADES',
  'UNVERIFIABLE',
] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

/** Statuses that never change again (the observation has a `finalized_at`). */
export const TERMINAL_STATUSES: readonly ObservationStatus[] = [
  'FINAL',
  'PARTIAL',
  'DATA_UNAVAILABLE',
  'MAPPING_AMBIGUOUS',
  'ELIGIBILITY_UNKNOWN',
  'NO_TRADES',
  'UNVERIFIABLE',
];

export const ELIGIBILITY_CLASSES = [
  'PENDING',
  'SPOT_AND_FUTURES',
  'SPOT_ONLY',
  'SPOT_FUTURES_UNKNOWN',
  'SPOT_UNAVAILABLE',
  'SPOT_UNKNOWN',
  'MAPPING_AMBIGUOUS',
] as const;
export type EligibilityClass = (typeof ELIGIBILITY_CLASSES)[number];

/**
 * Dashboard labels of the eligibility classes. Futures is listing evidence from snapshots before and
 * after the signal, never proof that a contract was tradable at the signal instant, and never a
 * Futures price, fill or leveraged return: every number on the page is LBank Spot.
 */
export const ELIGIBILITY_LABEL: Record<EligibilityClass, string> = {
  PENDING: 'Pending',
  SPOT_AND_FUTURES: 'Spot · Futures listed (snapshots)',
  SPOT_ONLY: 'Spot · Futures not listed (snapshots)',
  SPOT_FUTURES_UNKNOWN: 'Spot · Futures unknown',
  SPOT_UNAVAILABLE: 'Spot unavailable',
  SPOT_UNKNOWN: 'Spot unknown',
  MAPPING_AMBIGUOUS: 'Mapping ambiguous',
};

export const LISTING_STATUSES = ['YES', 'NO', 'UNKNOWN'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const MAPPING_STATUSES = ['PENDING', 'OK', 'AMBIGUOUS', 'NONE'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

/** v1 only (audit columns): the order of the High and Low bars. */
export const EXTREME_ORDERS = ['HIGH_FIRST', 'LOW_FIRST', 'SAME_BAR'] as const;
export type ExtremeOrder = (typeof EXTREME_ORDERS)[number];

/**
 * Order of the first highest and the first lowest trade, by their millisecond times. Two different
 * trades in one millisecond: SAME_MS (order unknown; LBank's response order is not used to guess).
 */
export const EXTREMES_ORDERS = ['HIGH_FIRST', 'LOW_FIRST', 'SAME_MS'] as const;
export type ExtremesOrder = (typeof EXTREMES_ORDERS)[number];

/**
 * How the observation start (the moment the star signal was usable) is proven, best first:
 *  - SCAN_COMMIT: the pipeline's scan stage finished, i.e. the Review Queue holding the row was
 *    committed and served by `/api/scan` before this instant (recorded right after the commit);
 *  - EVENT_COMMIT: no scan record; the event itself was committed and served on the LBank Spot
 *    page before this instant;
 *  - JOB_FIRST_SEEN: neither recorded; the first observation run that read the event.
 * Never the crawl time (t0), which precedes the signal by the scan.
 */
export const TIMING_SOURCES = ['SCAN_COMMIT', 'EVENT_COMMIT', 'JOB_FIRST_SEEN'] as const;
export type TimingSource = (typeof TIMING_SOURCES)[number];

/** The reference trade: still searched, found and verified, none in the window, or unprovable. */
export const REFERENCE_STATUSES = ['PENDING', 'VERIFIED', 'NO_TRADE', 'UNVERIFIED'] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

/**
 * Check of one minute's complete trade list against its candle:
 *  - VERIFIED: every page read and trade quantity ≥ candle volume (operator decision 2026-11-25: a
 *    surplus is the candle's undercount, recorded; LBank's trade list is never shorter on the tested
 *    pairs);
 *  - TRADES_BELOW_CANDLE: fewer trades than the candle counts (trades missing): unverified, retried;
 *  - PAGING_INCOMPLETE: the pages could not be read past one millisecond or the page cap;
 *  - FETCH_FAILED: request failed, timed out or rate-limited (retried);
 *  - PAIR_UNSUPPORTED: LBank answered "currency pair nonsupport" (10008).
 */
export const TRADE_CHECK_STATUSES = [
  'VERIFIED',
  'TRADES_BELOW_CANDLE',
  'PAGING_INCOMPLETE',
  'FETCH_FAILED',
  'PAIR_UNSUPPORTED',
] as const;
export type TradeCheckStatus = (typeof TRADE_CHECK_STATUSES)[number];

/**
 * States of a part of the window without a usable price record (docs § 6):
 *  - NO_BAR: LBank answered the range without a candle (completeness not established);
 *  - FETCH_FAILED: the last request for it failed, timed out or was rate-limited;
 *  - NOT_FETCHED: not requested yet;
 *  - PAIR_UNSUPPORTED: LBank stopped serving the pair (10008) before it was fetched;
 *  - TRADES_UNVERIFIED: a traded minute whose trade list is needed but not verified.
 * A zero-volume candle is not a gap: it is a verified minute without trades.
 */
export const GAP_STATES = [
  'NO_BAR',
  'FETCH_FAILED',
  'NOT_FETCHED',
  'PAIR_UNSUPPORTED',
  'TRADES_UNVERIFIED',
] as const;
export type GapState = (typeof GAP_STATES)[number];

export const OBS_RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;
export type ObsRunStatus = (typeof OBS_RUN_STATUSES)[number];

export const MARKET_LIST_KINDS = ['spot_pairs', 'futures_instruments'] as const;
export type MarketListKind = (typeof MARKET_LIST_KINDS)[number];

/** Reason codes (stable strings: database, exports, API and tests). */
export const OBS_REASON = {
  // mapping
  mappingPending: 'MAPPING_PENDING',
  noUsdtPair: 'NO_USDT_PAIR',
  multipleUsdtPairs: 'MULTIPLE_USDT_PAIRS',
  pairSymbolUnverified: 'PAIR_SYMBOL_UNVERIFIED',
  // Spot availability at the signal
  pairUnsupported: 'PAIR_UNSUPPORTED_BY_API',
  spotNotListed: 'SPOT_NOT_LISTED_AT_SIGNAL',
  spotEvidenceMissing: 'SPOT_EVIDENCE_MISSING',
  spotEvidenceConflict: 'SPOT_EVIDENCE_CONFLICT',
  noTradesNearSignal: 'NO_TRADES_NEAR_SIGNAL',
  // Futures listing evidence around the signal
  futuresSnapshotMissing: 'FUTURES_SNAPSHOT_MISSING',
  futuresEvidenceConflict: 'FUTURES_EVIDENCE_CONFLICT',
  futuresTickerUnverified: 'FUTURES_TICKER_UNVERIFIED',
  futuresNoRecentVolume: 'FUTURES_NO_RECENT_VOLUME',
  futuresList: 'FUTURES_LIST',
  // timing, reference and coverage
  timingPending: 'TIMING_PENDING',
  referencePending: 'REFERENCE_PENDING',
  referenceUnverified: 'REFERENCE_UNVERIFIED',
  windowOpen: 'WINDOW_OPEN',
  fetchPending: 'FETCH_PENDING',
  fetchIncomplete: 'FETCH_INCOMPLETE',
  fetchError: 'FETCH_ERROR',
  missingBars: 'MISSING_BARS',
  tradesUnverified: 'TRADES_UNVERIFIED',
  verificationPending: 'VERIFICATION_PENDING',
  noTrades: 'NO_TRADES_IN_WINDOW',
} as const;

/** Review flags (shown and exported; never an exclusion, never part of a status). */
export const OBS_FLAG = {
  /** At least one whole minute after the start was verified silent before the reference trade. */
  referenceDelayed: 'REFERENCE_DELAYED',
  /** Other trades share the reference's millisecond at a different price (LBank order used). */
  referenceSameMsTie: 'REFERENCE_SAME_MS_TIE',
  /** The highest / lowest price was set in a minute with exactly one trade (thin market). */
  singleTradeHigh: 'SINGLE_TRADE_HIGH',
  singleTradeLow: 'SINGLE_TRADE_LOW',
  /** The reference deviates more than MAPPING_MAX_PRICE_DEVIATION from the CMC price (identity check). */
  priceDeviation: 'PRICE_DEVIATION_FROM_CMC',
  /** CMC's LBank Spot list behind the mapping is older than LBANK_PAIRS_REFRESH_DAYS at the signal. */
  mappingSnapshotOld: 'MAPPING_SNAPSHOT_OLD',
} as const;

/** v1 reason codes that may appear on audit rows (never produced since rules v2). */
export const OBS_REASON_V1 = {
  entryPending: 'ENTRY_PENDING',
  entryUnavailable: 'ENTRY_UNAVAILABLE',
  entryTooLate: 'ENTRY_TOO_LATE',
  entryStale: 'ENTRY_STALE',
  priceDeviation: 'PRICE_DEVIATION_FROM_CMC',
} as const;

/** Sort keys of the observation list (API `sort`), all on the displayed (rules v2) values. */
export const OBS_SORT_KEYS = [
  'detected',
  'start',
  'stars',
  'points',
  'highest',
  'lowest',
  'referenceDelay',
  'coverage',
  'symbol',
] as const;
export type ObsSortKey = (typeof OBS_SORT_KEYS)[number];

/** Coverage filter: complete (no gap so far) or partial (any gap). */
export const COVERAGE_FILTERS = ['complete', 'partial'] as const;
export type CoverageFilter = (typeof COVERAGE_FILTERS)[number];

/** Flag filter: any review flag, the single-trade (spike) flags, or a delayed reference. */
export const FLAG_FILTERS = ['any', 'spike', 'delayed', 'none'] as const;
export type FlagFilter = (typeof FLAG_FILTERS)[number];

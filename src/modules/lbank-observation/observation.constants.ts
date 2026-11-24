/**
 * LBank Spot Price Observation (docs/lbank-spot-observation.md, ADR-0009): for each CMC star event
 * detected at or after the cutover, the LBank Spot entry-reference price and the highest High and
 * lowest Low of LBank Spot 1-minute candles over exactly t0 … t0 + 168 h. A descriptive observation:
 * no trade, stop, target, fee, funding, leverage or profit is modelled.
 *
 * Changing a rule below or in `observation-rules.ts` / `listing-evidence.ts` is a calculation change:
 * bump OBSERVATION_RULES_VERSION (stored on every observation and result) and update the doc. The
 * value sets are PostgreSQL enum types (migration M015): adding a value needs a migration as well.
 */
export const OBSERVATION_RULES_VERSION = 'lbank-spot-obs-1';

/** The price source label shown with every number (never CMC). */
export const PRICE_SOURCE = 'LBank Spot · 1-minute OHLC (REST /v2/kline.do, type=minute1)';
export const PRICE_INTERVAL = 'minute1';

/** Provider row of the LBank public API (its circuit breaker and request budget). */
export const LBANK_SPOT_PROVIDER = 'lbank_spot';

export const MINUTE_MS = 60_000;
export const WINDOW_HOURS = 168;
/** Exactly t0 + 168 h; no extension to the end of a UTC day. */
export const WINDOW_MS = WINDOW_HOURS * 3_600_000;

/**
 * Entry reference: the OPEN of the first 1-minute bar opening at or after t0. With contiguous bars
 * that bar opens within 60 s of t0 (feasibility: 15–60 s on every tested event); one missing bar is
 * tolerated, anything later is ENTRY_TOO_LATE and never presented as an entry at t0.
 */
export const MAX_ENTRY_DELAY_MS = 2 * MINUTE_MS;

/**
 * LBank's bar OPEN is the previous bar's CLOSE (10 078 of 10 078 consecutive bars on every tested
 * window), i.e. the last traded price at the bar's opening instant. The entry is stale when no
 * bar with trades lies within this long before the entry bar (an illiquid pair's last trade).
 */
export const MAX_ENTRY_STALENESS_MS = 60 * MINUTE_MS;
/** Bars fetched before t0: the entry's last trade and the Spot series spanning the signal. */
export const ENTRY_LOOKBACK_MS = 60 * MINUTE_MS;
/** Window after t0 in which a trade counts as "trading at the signal". */
export const SIGNAL_TRADE_WINDOW_MS = 60 * MINUTE_MS;

/**
 * The API also returns the minute still in progress; a bar is stored only once closed, judged by the
 * response's own server time (`ts`) less this margin (a closed bar was final 1.2 s after its close).
 */
export const CLOSED_BAR_MARGIN_MS = 5_000;

/** After the window ends: gaps and missing pages are retried this long before a terminal status. */
export const FINALIZE_RETRY_MS = 24 * 3_600_000;

/** An LBank markets list counts as evidence at the signal only when fetched within this of t0. */
export const EVIDENCE_MAX_LAG_MS = 2 * 3_600_000;

/**
 * Identity check (never a price input): an LBank entry deviating more than this from the CMC price
 * at detection makes the mapping uncertain. Tested events deviated 0.08–0.91 %.
 */
export const MAPPING_MAX_PRICE_DEVIATION = '0.25';

/** `GET /v2/kline.do` accepts size 1–2000 (2001 → error 10003). */
export const KLINE_MAX_SIZE = 2000;
/** Pages fetched for one pair in one run (a full 168 h window is 6 pages). */
export const MAX_PAGES_PER_PAIR_PER_RUN = 8;

export const PREFERRED_QUOTE = 'USDT';

export const OBSERVATION_STATUSES = [
  'ACTIVE',
  'FINAL',
  'PARTIAL',
  'DATA_UNAVAILABLE',
  'MAPPING_AMBIGUOUS',
  'ELIGIBILITY_UNKNOWN',
] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

/** Statuses that never change again (the observation has a `finalized_at`). */
export const TERMINAL_STATUSES: readonly ObservationStatus[] = [
  'FINAL',
  'PARTIAL',
  'DATA_UNAVAILABLE',
  'MAPPING_AMBIGUOUS',
  'ELIGIBILITY_UNKNOWN',
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

/** Dashboard labels of the eligibility classes. */
export const ELIGIBILITY_LABEL: Record<EligibilityClass, string> = {
  PENDING: 'Pending',
  SPOT_AND_FUTURES: 'Spot + Futures eligible',
  SPOT_ONLY: 'Spot only',
  SPOT_FUTURES_UNKNOWN: 'Spot available / Futures unknown',
  SPOT_UNAVAILABLE: 'Spot unavailable',
  SPOT_UNKNOWN: 'Spot unknown',
  MAPPING_AMBIGUOUS: 'Mapping ambiguous',
};

export const LISTING_STATUSES = ['YES', 'NO', 'UNKNOWN'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const MAPPING_STATUSES = ['PENDING', 'OK', 'AMBIGUOUS', 'NONE'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

/** Order of the High and Low bars; inside one bar the order is unknown (no trade times used). */
export const EXTREME_ORDERS = ['HIGH_FIRST', 'LOW_FIRST', 'SAME_BAR'] as const;
export type ExtremeOrder = (typeof EXTREME_ORDERS)[number];

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
  priceDeviation: 'PRICE_DEVIATION_FROM_CMC',
  // Spot availability at the signal
  pairUnsupported: 'PAIR_UNSUPPORTED_BY_API',
  spotNotListed: 'SPOT_NOT_LISTED_AT_SIGNAL',
  spotEvidenceMissing: 'SPOT_EVIDENCE_MISSING',
  spotEvidenceConflict: 'SPOT_EVIDENCE_CONFLICT',
  noTradesNearSignal: 'NO_TRADES_NEAR_SIGNAL',
  // Futures availability at the signal
  futuresSnapshotMissing: 'FUTURES_SNAPSHOT_MISSING',
  futuresEvidenceConflict: 'FUTURES_EVIDENCE_CONFLICT',
  futuresTickerUnverified: 'FUTURES_TICKER_UNVERIFIED',
  futuresNoRecentVolume: 'FUTURES_NO_RECENT_VOLUME',
  futuresList: 'FUTURES_LIST',
  // entry and coverage
  entryPending: 'ENTRY_PENDING',
  entryUnavailable: 'ENTRY_UNAVAILABLE',
  entryTooLate: 'ENTRY_TOO_LATE',
  entryStale: 'ENTRY_STALE',
  windowOpen: 'WINDOW_OPEN',
  fetchPending: 'FETCH_PENDING',
  fetchIncomplete: 'FETCH_INCOMPLETE',
  fetchError: 'FETCH_ERROR',
  missingBars: 'MISSING_BARS',
  noTrades: 'NO_TRADES_IN_WINDOW',
} as const;

/** Sort keys of the observation list (API `sort`). */
export const OBS_SORT_KEYS = [
  'detected',
  'stars',
  'points',
  'rise',
  'drop',
  'entryDelay',
  'coverage',
  'symbol',
] as const;
export type ObsSortKey = (typeof OBS_SORT_KEYS)[number];

/** Coverage filter: complete (every expected bar so far) or partial (any missing bar). */
export const COVERAGE_FILTERS = ['complete', 'partial'] as const;
export type CoverageFilter = (typeof COVERAGE_FILTERS)[number];

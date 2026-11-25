// Vocabulary of the LBank Spot observation (docs/lbank-spot-observation.md § 4–6, rules
// lbank-spot-obs-2): statuses, Spot / Futures evidence classes, start provenance, gap states, review
// flags and reason codes in plain words. Codes without an entry fall back to `humanize`, never to
// the raw code.
import { type StatusMap, humanize } from '../../lib/constants';

import { LISTING_REASON } from '../forward/labels';

export const STATUS: StatusMap = {
  ACTIVE: ['accent', 'Active'],
  FINAL: ['good', 'Final'],
  NO_TRADES: ['', 'No trades in window'],
  PARTIAL: ['warning', 'Partial'],
  UNVERIFIABLE: ['serious', 'Unverifiable'],
  DATA_UNAVAILABLE: ['serious', 'Data unavailable'],
  MAPPING_AMBIGUOUS: ['serious', 'Mapping ambiguous'],
  ELIGIBILITY_UNKNOWN: ['warning', 'Eligibility unknown'],
};

/** Spot / Futures evidence classes. Futures is listing evidence from snapshots, never a Futures price. */
export const ELIGIBILITY: StatusMap = {
  PENDING: ['', 'Pending'],
  SPOT_AND_FUTURES: ['good', 'Spot · Futures listed (snapshots)'],
  SPOT_ONLY: ['accent', 'Spot · Futures not listed (snapshots)'],
  SPOT_FUTURES_UNKNOWN: ['', 'Spot · Futures unknown'],
  SPOT_UNAVAILABLE: ['serious', 'Spot unavailable'],
  SPOT_UNKNOWN: ['warning', 'Spot unknown'],
  MAPPING_AMBIGUOUS: ['serious', 'Mapping ambiguous'],
};

/** How the LBank pair was tied to the CMC id. */
export const MAPPING_TEXT: Record<string, string> = {
  PENDING: 'not decided yet',
  OK: 'matched by CMC id',
  AMBIGUOUS: 'not certain',
  NONE: 'no LBank pair',
};

/** Spot availability at the signal; Unknown is its own state, never Yes or No. */
export const LISTING_TEXT: Record<string, string> = {
  YES: 'yes',
  NO: 'no',
  UNKNOWN: 'unknown',
};

/** Futures listing evidence from a snapshot before and one after the signal (not proof at the instant). */
export const FUTURES_TEXT: Record<string, string> = {
  YES: 'listed in both snapshots around the signal',
  NO: 'in neither snapshot around the signal',
  UNKNOWN: 'unknown (snapshots missing or disagree)',
};

export const TRADING_TEXT: Record<string, string> = {
  TRADES_OBSERVED: 'traded within an hour of the start',
  NO_RECENT_TRADES: 'no trade within an hour of the start',
  UNKNOWN: 'trading unknown',
};

/** How the window start was proven. */
export const TIMING_TEXT: Record<string, string> = {
  SCAN_COMMIT: 'Review Queue published (scan committed and served)',
  EVENT_COMMIT: 'no scan record: when the event itself was committed',
  JOB_FIRST_SEEN: 'no record: when the observation job first saw it',
};

export const ORDER: Record<string, string> = {
  HIGH_FIRST: 'the highest trade came first',
  LOW_FIRST: 'the lowest trade came first',
  SAME_MS: 'highest and lowest in the same millisecond: order unknown',
};

export const GAP_TEXT: Record<string, string> = {
  NO_BAR: 'LBank answered without a candle (completeness not established)',
  FETCH_FAILED: 'request failed, timed out or was rate-limited',
  NOT_FETCHED: 'not fetched yet',
  PAIR_UNSUPPORTED: 'LBank no longer serves the pair',
  TRADES_UNVERIFIED: 'trades of a needed minute not verified',
};

export const FLAG: Record<string, [string, string]> = {
  REFERENCE_DELAYED: [
    'Delayed',
    'At least one whole minute after the start passed without a trade',
  ],
  REFERENCE_SAME_MS_TIE: [
    'Same-ms tie',
    'Other trades share the reference’s millisecond at another price (LBank’s order used)',
  ],
  SINGLE_TRADE_HIGH: ['Thin high', 'The highest price was set in a minute with exactly one trade'],
  SINGLE_TRADE_LOW: ['Thin low', 'The lowest price was set in a minute with exactly one trade'],
  PRICE_DEVIATION_FROM_CMC: [
    'CMC deviation',
    'The reference differs more than 25 % from the CMC price: review the pair',
  ],
  MAPPING_SNAPSHOT_OLD: [
    'Old mapping',
    'CMC’s LBank list behind the pair was older than its refresh period at the signal',
  ],
};

const REASON: Record<string, string> = {
  MAPPING_PENDING: 'LBank pair not decided yet',
  NO_USDT_PAIR: 'no LBank USDT pair for this coin',
  MULTIPLE_USDT_PAIRS: 'several LBank USDT pairs: not certain which is this coin',
  PAIR_SYMBOL_UNVERIFIED: 'the LBank symbol cannot be confirmed from CoinMarketCap',
  PRICE_DEVIATION_FROM_CMC:
    'LBank price differs more than 25 % from CoinMarketCap: review the pair',
  PAIR_UNSUPPORTED_BY_API: 'LBank no longer serves this pair (delisted or unknown)',
  SPOT_NOT_LISTED_AT_SIGNAL: 'not listed on LBank Spot at the signal',
  SPOT_EVIDENCE_MISSING: 'no evidence whether Spot traded at the signal',
  SPOT_EVIDENCE_CONFLICT: 'Spot evidence at the signal disagrees',
  NO_TRADES_NEAR_SIGNAL: 'no trade within an hour of the start',
  FUTURES_SNAPSHOT_MISSING: 'LBank’s Futures list was not read near the signal',
  FUTURES_EVIDENCE_CONFLICT: 'Futures snapshots before and after the signal disagree',
  FUTURES_TICKER_UNVERIFIED: 'a Futures contract with this ticker may be another coin',
  FUTURES_NO_RECENT_VOLUME: 'Futures contract without recent volume',
  FUTURES_LIST: 'Futures list',
  TIMING_PENDING: 'the moment the signal was usable is not established yet',
  REFERENCE_PENDING: 'the first trade after the start is not verified yet',
  REFERENCE_UNVERIFIED: 'no provable first trade after the start',
  WINDOW_OPEN: 'window still running: values are provisional',
  FETCH_PENDING: 'latest minutes not fetched yet',
  FETCH_INCOMPLETE: 'window not fully fetched or verified after the retries',
  FETCH_ERROR: 'the last LBank request failed; it is retried',
  MISSING_BARS: 'LBank answered some minutes without a candle',
  TRADES_UNVERIFIED: 'the trades of a needed minute could not be verified',
  VERIFICATION_PENDING: 'trades of a needed minute not checked yet',
  NO_TRADES_IN_WINDOW: 'no trade in the whole window',
  // rules v1 (audit rows only)
  ENTRY_PENDING: 'entry minute not fetched yet (rules v1)',
  ENTRY_UNAVAILABLE: 'no LBank minute after the signal (rules v1)',
  ENTRY_TOO_LATE: 'first LBank minute more than 2 minutes after the signal (rules v1)',
  ENTRY_STALE: 'no trade in the hour before entry (rules v1)',
};

/** A reason code, e.g. `FUTURES_LIST:LIST_STALE`, in words. */
export function obsReasonText(code: string): string {
  const [k = '', detail] = code.split(':');
  const base = REASON[k] ?? humanize(k);
  if (!detail) return base;
  return `${base}: ${LISTING_REASON[detail] ?? humanize(detail).toLowerCase()}`;
}

/** "+7.67 s", "+12 min 04 s", "+45 min 37 s" (exact value in the tooltip). */
export function delayText(ms: number): string {
  if (ms < 60_000) return `+${(ms / 1000).toFixed(ms < 10_000 ? 3 : 1)} s`;
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h
    ? `+${h} h ${String(m).padStart(2, '0')} min`
    : `+${m} min ${String(s).padStart(2, '0')} s`;
}

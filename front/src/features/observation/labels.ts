// Vocabulary of the LBank Spot observation (docs/lbank-spot-observation.md § 4–6): statuses,
// eligibility classes, listing answers and reason codes in plain words. Codes without an entry
// fall back to `humanize`, never to the raw code.
import { type StatusMap, humanize } from '../../lib/constants';

import { LISTING_REASON } from '../forward/labels';

export const STATUS: StatusMap = {
  ACTIVE: ['accent', 'Active'],
  FINAL: ['good', 'Final'],
  PARTIAL: ['warning', 'Partial'],
  DATA_UNAVAILABLE: ['serious', 'Data unavailable'],
  MAPPING_AMBIGUOUS: ['serious', 'Mapping ambiguous'],
  ELIGIBILITY_UNKNOWN: ['warning', 'Eligibility unknown'],
};

export const ELIGIBILITY: StatusMap = {
  PENDING: ['', 'Pending'],
  SPOT_AND_FUTURES: ['good', 'Spot + Futures eligible'],
  SPOT_ONLY: ['accent', 'Spot only'],
  SPOT_FUTURES_UNKNOWN: ['', 'Spot available / Futures unknown'],
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

/** A listing answer at the signal; Unknown is its own state, never Yes or No. */
export const LISTING_TEXT: Record<string, string> = {
  YES: 'yes',
  NO: 'no',
  UNKNOWN: 'unknown',
};

export const TRADING_TEXT: Record<string, string> = {
  TRADES_OBSERVED: 'traded within an hour of the signal',
  NO_RECENT_TRADES: 'no trade within an hour of the signal',
  UNKNOWN: 'trading unknown',
};

export const ORDER: Record<string, string> = {
  HIGH_FIRST: 'the High came first',
  LOW_FIRST: 'the Low came first',
  SAME_BAR: 'High and Low in the same minute: order unknown',
};

const REASON: Record<string, string> = {
  MAPPING_PENDING: 'LBank pair not decided yet',
  NO_USDT_PAIR: 'no LBank USDT pair for this coin',
  MULTIPLE_USDT_PAIRS: 'several LBank USDT pairs: not certain which is this coin',
  PAIR_SYMBOL_UNVERIFIED: 'the LBank symbol cannot be confirmed from CoinMarketCap',
  PRICE_DEVIATION_FROM_CMC:
    'LBank price differs more than 25 % from CoinMarketCap: maybe another coin',
  PAIR_UNSUPPORTED_BY_API: 'LBank no longer serves this pair (delisted or unknown)',
  SPOT_NOT_LISTED_AT_SIGNAL: 'not listed on LBank Spot at the signal',
  SPOT_EVIDENCE_MISSING: 'no evidence whether Spot traded at the signal',
  SPOT_EVIDENCE_CONFLICT: 'Spot evidence at the signal disagrees',
  NO_TRADES_NEAR_SIGNAL: 'no trade within an hour of the signal',
  FUTURES_SNAPSHOT_MISSING: 'LBank’s Futures list was not read near the signal',
  FUTURES_EVIDENCE_CONFLICT: 'Futures lists before and after the signal disagree',
  FUTURES_TICKER_UNVERIFIED: 'a Futures contract with this ticker may be another coin',
  FUTURES_NO_RECENT_VOLUME: 'Futures contract without recent volume',
  FUTURES_LIST: 'Futures list',
  ENTRY_PENDING: 'entry minute not fetched yet',
  ENTRY_UNAVAILABLE: 'no LBank minute after the signal',
  ENTRY_TOO_LATE: 'first LBank minute more than 2 minutes after the signal',
  ENTRY_STALE: 'no trade in the hour before entry: the entry price is old',
  WINDOW_OPEN: 'window still running: values are provisional',
  FETCH_PENDING: 'latest minutes not fetched yet',
  FETCH_INCOMPLETE: 'window not fully fetched',
  FETCH_ERROR: 'the last LBank request failed; it is retried',
  MISSING_BARS: 'some 1-minute candles are missing',
  NO_TRADES_IN_WINDOW: 'no trade in the whole window',
};

/** A reason code, e.g. `FUTURES_LIST:LIST_STALE`, in words. */
export function obsReasonText(code: string): string {
  const [k = '', detail] = code.split(':');
  const base = REASON[k] ?? humanize(k);
  if (!detail) return base;
  return `${base}: ${LISTING_REASON[detail] ?? humanize(detail).toLowerCase()}`;
}

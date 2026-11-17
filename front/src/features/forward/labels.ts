// Vocabulary of the forward-test page: event and check statuses, note chips, list filters and the
// plain-language definitions shown under "How to read this table" (docs/forward-test.md).
import type { StatusMap } from '../../lib/constants';
import { tz } from '../../lib/format';

import type {
  BithumbFilter,
  CheckStatus,
  EventSort,
  ForwardStatus,
  Listed,
  MarketFilter,
  ResultFilter,
} from './types';

export const FWD_STATUS: StatusMap = {
  OPEN: ['', 'Open'],
  TRACKING: ['accent', 'Tracking'],
  AWAITING_FINAL_DAY: ['warning', 'Awaiting final day'],
  FINAL: ['good', 'Final'],
  INCOMPLETE: ['serious', 'Incomplete'],
};

/** The result of an event's latest High check. */
export const CHECK: Record<CheckStatus, readonly [tone: string, label: string, help: string]> = {
  NOT_CHECKED: [
    '',
    'Not checked yet',
    'No High check has evaluated this event yet: its identification day (UTC) has not ended, or the daily check has not run since it ended.',
  ],
  NEW_RECORD: [
    'good',
    'New record found',
    'The newest checked day raised the highest confirmed High (or gave the first one). Highest High and Return show the new record.',
  ],
  UNCHANGED: [
    'accent',
    'Checked; record unchanged',
    'The newest checked day had no higher High. The previous record stands; "checked through" moved forward.',
  ],
  DATA_UNAVAILABLE: [
    'warning',
    'Data unavailable',
    'A closed UTC day has no usable CMC daily High yet (not published or invalid). It is retried automatically; nothing is filled in.',
  ],
  RETRIEVAL_ERROR: [
    'critical',
    'Data retrieval error',
    'The request for the daily row or the evaluation failed. Earlier results are kept; it is retried automatically.',
  ],
};

export const FLAG_TEXT: Record<string, string> = {
  INCOMPLETE_DAY0: 'day 0 never confirmed',
  DAY0_UNRESOLVED: 'day 0 unconfirmed',
  FINAL_DAY_PENDING: 'final day pending',
  HIGH_MISSING: 'High missing',
  HIGH_INVALID: 'High invalid',
  PEAK_TIE_UNOBSERVED_DAY0: 'tie with day 0',
  CONTRACT_EVIDENCE_CHANGED: 'contract changed',
};
export const DAY0_FLAGS = new Set(['DAY0_UNRESOLVED', 'INCOMPLETE_DAY0']);

export function flagText(code: string): string {
  const [k = '', ...rest] = String(code).split(':');
  return `${FLAG_TEXT[k] || k.replace(/_/g, ' ').toLowerCase()}${rest.length ? ` ${rest.join(':')}` : ''}`;
}

/** The status filter: the URL's `view` holds a group of statuses or one status. */
export const STATUS_FILTERS: readonly (readonly [
  key: string,
  label: string,
  api: { view: 'active' | 'final' | 'incomplete' | 'all'; status?: ForwardStatus },
])[] = [
  ['active', 'Active (open, tracking, awaiting)', { view: 'active' }],
  ['open', 'Open', { view: 'all', status: 'OPEN' }],
  ['tracking', 'Tracking', { view: 'all', status: 'TRACKING' }],
  ['awaiting', 'Awaiting final day', { view: 'all', status: 'AWAITING_FINAL_DAY' }],
  ['final', 'Final', { view: 'final' }],
  ['incomplete', 'Incomplete', { view: 'incomplete' }],
  ['all', 'All statuses', { view: 'all' }],
];

export const RESULT_FILTERS: readonly (readonly [ResultFilter | '', string])[] = [
  ['', 'All results'],
  ['CONFIRMED', 'With a confirmed High'],
  ['DAY0_UNCONFIRMED', 'Day 0 High unconfirmed'],
  ['NOT_CHECKED', CHECK.NOT_CHECKED[1]],
  ['NEW_RECORD', CHECK.NEW_RECORD[1]],
  ['UNCHANGED', CHECK.UNCHANGED[1]],
  ['DATA_UNAVAILABLE', CHECK.DATA_UNAVAILABLE[1]],
  ['RETRIEVAL_ERROR', CHECK.RETRIEVAL_ERROR[1]],
];

/** The coin's LBank listing now: exact combinations, or one market whatever the other. */
export const MARKET_FILTERS: readonly (readonly [MarketFilter | '', string])[] = [
  ['', 'All'],
  ['both', 'Spot and Futures'],
  ['spot_only', 'Spot only'],
  ['futures_only', 'Futures only'],
  ['spot', 'Spot (with or without Futures)'],
  ['futures', 'Futures (with or without Spot)'],
  ['neither', 'Neither'],
  ['unknown', 'Unknown (not verified)'],
];

export const BITHUMB_FILTERS: readonly (readonly [BithumbFilter | '', string])[] = [
  ['', 'All'],
  ['listed', 'Listed on Bithumb'],
  ['not_listed', 'Not listed'],
  ['unknown', 'Unknown (not verified)'],
];

/** CSS class and word of a listing answer. Unknown is its own state, never shown as No. */
export const LISTED: Record<Listed, readonly [cls: string, text: string]> = {
  YES: ['yes', 'Yes'],
  NO: ['no', 'No'],
  UNKNOWN: ['unknown', 'Unknown'],
};
export const BITHUMB_TEXT: Record<Listed, string> = {
  YES: 'Listed',
  NO: 'Not listed',
  UNKNOWN: 'Unknown',
};

/** Why a listing is Unknown (reason codes of the API). */
export const LISTING_REASON: Record<string, string> = {
  LIST_NOT_FETCHED: 'the list has not been fetched yet',
  LIST_FAILED: 'the last fetch of the list failed and no complete list is stored',
  LIST_INCOMPLETE: 'the last fetch returned an incomplete list',
  LIST_STALE: 'the stored list is too old to count',
  LIST_UNSUPPORTED: 'this data source has no exchange markets lists',
  UNMAPPED_PAIR_SAME_TICKER:
    'the list has a pair with this ticker but no CMC id, so it may or may not be this coin',
};

export const SORT_LABEL: Record<EventSort, string> = {
  detected: 'identification time',
  return: 'Return',
  stars: 'stars',
  points: 'points',
  multiple3d: '3d ratio',
  multiple7d: '7d ratio',
  multiple30d: '30d ratio',
};

/** Local clock time of 00:00 UTC in the display timezone, e.g. "03:30". */
export function utcMidnightLocal(): string {
  return new Date('2026-01-01T00:00:00Z').toLocaleTimeString('en-GB', {
    timeZone: tz(),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export const DAY0_EXPLAINED =
  "Day 0 is the UTC day of identification. Its daily High can come from before identification, so it counts only when CMC's own time of that High is at or after identification. Otherwise it is shown in yellow, kept out of Return and of every statistic, and settled only if a later day's High reaches it.";

export const OVERLAP_EXPLAINED =
  'Other events of the same coin (any star count) whose windows share at least one moment with this one. Each is its own event, one per coin, UTC day and star count, but they follow the same price path, so they are correlated rather than independent. The count does not include this row.';

export const AVERAGE_RETURN_EXPLAINED =
  "The arithmetic mean of the Returns shown for the coin's events, over every stored event of the coin (same CMC id, any status and star count, whatever the filters or page), with the number of events and how many have a Return. An event without a Return is left out, never counted as 0 %. If any of those Returns is still so far or a lower bound (≥), the average is a lower bound too and is marked ≥: not a final result. It is a peak return, not trading profit, and the events of one coin follow one price path.";

export const LISTINGS_EXPLAINED =
  "Whether the coin is listed now in LBank's Spot markets, LBank's Futures markets (perpetual contracts) and Bithumb's Spot markets. Each comes from that exchange's own markets list on CoinMarketCap, matched by CMC id: Futures is checked in LBank's Futures list, never inferred from a Spot listing. Unknown means that list is not verified (not fetched yet, failed, incomplete or too old), so it is never shown as No. A listing, not a trading-status check; LBank Futures and Bithumb never change Tier 1 eligibility, stars or points.";

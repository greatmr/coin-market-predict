// Vocabulary of the forward-test page: event and check statuses, note chips, list filters and the
// plain-language definitions shown under "How to read this table" (docs/forward-test.md).
import type { StatusMap } from '../../lib/constants';
import { tz } from '../../lib/format';

import type { CheckStatus, EventSort, ForwardStatus, ResultFilter } from './types';

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

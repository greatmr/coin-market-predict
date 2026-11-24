// Status vocabularies ([dot tone, label] per server value), reason texts and role texts.
import type { Permission, Role } from '../types/api';

export type Tone = '' | 'good' | 'warning' | 'serious' | 'critical' | 'accent';
export type StatusMap = Record<string, readonly [Tone, string]>;

export const ELIG: StatusMap = {
  ELIGIBLE: ['good', 'Eligible'],
  NEEDS_REVIEW: ['warning', 'Needs review'],
  EXCLUDED: ['', 'Excluded'],
};
export const LBANK: StatusMap = {
  VERIFIED: ['good', 'LBank verified'],
  PAIR_LISTED_UNVERIFIED: ['warning', 'LBank listed, unverified'],
  NOT_LISTED: ['', 'Not on LBank'],
  NOT_TRADABLE: ['critical', 'LBank not tradable'],
  UNKNOWN: ['serious', 'LBank unknown'],
};
export const CURRENT: StatusMap = {
  OK: ['good', 'Quote OK'],
  STALE: ['serious', 'Stale quote'],
  TIMESTAMP_UNVERIFIED: ['serious', 'Time unverified'],
  MISMATCHED: ['critical', 'Mismatched'],
  MISSING: ['critical', 'No quote'],
  INVALID: ['critical', 'Invalid quote'],
};
export const QUEUE: StatusMap = {
  PUBLISHED: ['good', 'Published'],
  EMPTY: ['', 'Empty'],
  WITHHELD_INCOMPLETE_BATCH: ['critical', 'Withheld: incomplete batch'],
  WITHHELD_LBANK_UNAVAILABLE: ['critical', 'Withheld: LBank list unavailable'],
};
export const BATCH: StatusMap = {
  COMPLETE: ['good', 'Complete'],
  INCOMPLETE: ['serious', 'Incomplete'],
  FAILED: ['critical', 'Failed'],
};
export const RUN: StatusMap = {
  running: ['accent', 'Running'],
  succeeded: ['good', 'Succeeded'],
  partial: ['warning', 'Partial'],
  failed: ['critical', 'Failed'],
  skipped: ['', 'Skipped'],
  missed: ['', 'Missed'],
  interrupted: ['critical', 'Interrupted'],
};
export const statusText = (map: StatusMap, key: string | null | undefined): string =>
  (key && map[key]?.[1]) || key || '—';

export const STAGES: readonly (readonly [string, string])[] = [
  ['discover', 'Discover'],
  ['collect', 'Collect'],
  ['lbank', 'LBank'],
  ['daily', 'Daily rows'],
  ['scan', 'Scan'],
  ['venues', 'Venues'],
  ['export', 'Export'],
  ['notify', 'Notify'],
  ['forward', 'Forward test'],
];

const REASON_TEXT: Record<string, string> = {
  RANK_OUT_OF_RANGE: 'rank outside 101–1200',
  RANK_MISSING: 'no CMC rank',
  RANK_AMBIGUOUS: 'duplicate rank in batch',
  MARKET_CAP_BELOW_MIN: 'market cap below $15M',
  MARKET_CAP_MISSING: 'market cap missing',
  LISTING_AGE_BELOW_60D: 'listed under 60 days',
  DATE_ADDED_MISSING: 'no listing date',
  DATE_ADDED_AFTER_SCAN: 'listing date after scan',
  STABLECOIN: 'stablecoin',
  TOKENIZED_ASSET: 'tokenized stock or asset',
  CLASS_AMBIGUOUS: 'class ambiguous',
  NO_LBANK_SPOT_PAIR: 'no LBank Spot pair',
  LBANK_NOT_TRADABLE: 'LBank pair not tradable',
  LBANK_PAIR_UNVERIFIED: 'LBank pair unverified',
  LBANK_STATUS_UNKNOWN: 'LBank status unknown',
  DAILY_ROW_MISSING: 'a completed day is missing',
  DAILY_ROW_INVALID: 'a completed day is invalid',
  ZERO_BASELINE: 'zero baseline',
  NOT_EVALUATED_EXCLUDED: 'not evaluated (excluded)',
  CURRENT_MISSING: 'no current quote',
  CURRENT_STALE: 'stale quote',
  TIMESTAMP_UNVERIFIED: 'no provider time',
  TIMESTAMP_IN_FUTURE: 'provider time in the future',
  MISMATCHED_OBSERVATION: 'volume and cap mismatch',
  CURRENT_CAP_INVALID: 'current cap invalid',
  CURRENT_VOLUME_INVALID: 'current volume invalid',
};
export function reasonText(code: string | null | undefined): string {
  if (!code) return '';
  const [k = '', detail] = String(code).split(':');
  const base = REASON_TEXT[k] || k.replace(/_/g, ' ').toLowerCase();
  return `${base}${detail ? ` (${detail.replace(/_/g, ' ').toLowerCase()})` : ''}`;
}

/* Multiples are drawn on a log scale up to 6×, so the 1.5× line sits at a fixed spot. */
export const MULT_MAX = 6;
export const multPos = (m: number | null): number =>
  Math.max(0, Math.min(1, Math.log1p(Math.max(0, m ?? 0)) / Math.log1p(MULT_MAX)));

export const ROLE_TEXT: Record<Role, readonly [string, string]> = {
  owner: ['Owner', 'Everything, including users, the Telegram audience and the Claude agent.'],
  analyzer: [
    'Analyzer',
    'Every data page, run health and exports; can reprocess a batch and refresh the LBank list.',
  ],
  reviewer: ['Reviewer', 'Market pages and coin details; records reviews and LBank decisions.'],
};
export const PERMISSION_TEXT: Record<Permission, string> = {
  'data:read': 'See the overview, lists and coin details',
  'health:read': 'See runs, batches and source health',
  'exports:read': 'Download CSV exports',
  'review:write': 'Record reviews and LBank decisions',
  'scan:operate': 'Reprocess a batch, refresh the LBank list and retry a failed crawl',
  'telegram:manage': 'Manage Telegram members and re-send reports',
  'users:manage': 'Add, change and remove users',
  'pipeline:recover': 'Recover a failed or missed pipeline run',
  'agent:use': 'Ask the Claude agent for its view on a coin (limited runs)',
};

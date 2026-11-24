// URL structure (React Router, no hash routing). List state lives in the query string so every view
// can be shared, reloaded and reached with the back button:
//   /queue?q=btc&page=2&rows=250&view=scatter      /forward?view=final&stars=3&sort=return&page=1
//   /coins/1027?tab=history&batch=<id>             /login?next=/queue
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import type { Permission } from '../types/api';

export type SectionKey =
  | 'overview'
  | 'queue'
  | 'observation'
  | 'forward'
  | 'data'
  | 'batches'
  | 'access'
  | 'users'
  | 'account';

export interface Section {
  key: SectionKey;
  path: string;
  label: string;
  title: string;
  sub: string;
  /** Permission needed to see it (the rest need data:read, which every role has). */
  permission?: Permission;
  /** Rail badge: the overview counts, or a count a page reports. */
  counted?: boolean;
  /** Sidebar group: the screen and its lists, data and operations, or settings. */
  group: SectionGroup;
  /** Kept in the phone's bottom bar; every other section is under "More". */
  primary?: boolean;
}

export type SectionGroup = 'screen' | 'data' | 'settings';
export const SECTION_GROUPS: readonly (readonly [SectionGroup, string])[] = [
  ['screen', 'Screen'],
  ['data', 'Data & operations'],
  ['settings', 'Settings'],
];

export const SECTIONS: readonly Section[] = [
  {
    key: 'overview',
    group: 'screen',
    primary: true,
    path: '/',
    label: 'Overview',
    title: 'Overview',
    sub: 'Hourly Tier 1 screen of every listed coin. Research only: nothing here is a buy signal and no order is placed.',
  },
  {
    key: 'queue',
    group: 'screen',
    primary: true,
    path: '/queue',
    label: 'Review queue',
    title: 'Review queue',
    sub: 'Eligible coins whose rolling-24h VMC is at least 1.5× one of their own 3, 7 or 30-day means, ranked by stars, then weighted points (3d 60 · 7d 25 · 30d 15). For human chart review.',
    counted: true,
  },
  {
    key: 'forward',
    group: 'screen',
    path: '/forward',
    label: 'Forward test',
    title: 'Forward test',
    sub: 'Legacy tracker: events detected before the cutover, followed to the end of the UTC day containing detection + 168 h on CMC daily Highs. It takes no new events; it is hidden from navigation once every event has a terminal outcome.',
    counted: true,
  },
  {
    key: 'observation',
    group: 'screen',
    primary: true,
    path: '/lbank-spot',
    label: 'LBank Spot',
    title: 'LBank Spot price observation',
    sub: 'Each CMC 1, 2 and 3-star event since the cutover, observed on LBank Spot 1-minute candles for exactly 168 hours: the entry reference, the highest High and the lowest Low. Two independent price extremes, not a trade, not profit, not a stop.',
    counted: true,
  },
  {
    key: 'data',
    group: 'data',
    primary: true,
    path: '/data',
    label: 'Data',
    title: 'Data',
    sub: 'Data quality of the latest batch (quotes, LBank mapping and list, scan warnings, last export), how many coins were screened and why the others are left out. Only the review queue is stored per coin.',
  },
  {
    key: 'batches',
    group: 'data',
    path: '/runs',
    label: 'Runs & health',
    title: 'Runs & health',
    sub: "Crawl batches, pipeline runs and the source's request budget.",
    permission: 'health:read',
  },
  {
    key: 'access',
    group: 'settings',
    path: '/telegram',
    label: 'Telegram',
    title: 'Telegram',
    sub: 'Who receives the hourly report, and reports that did not arrive.',
    permission: 'telegram:manage',
    counted: true,
  },
  {
    key: 'users',
    group: 'settings',
    path: '/users',
    label: 'Users',
    title: 'Users',
    sub: 'Who can sign in to this dashboard, and what each role may see and do.',
    permission: 'users:manage',
  },
  {
    key: 'account',
    group: 'settings',
    path: '/account',
    label: 'Preferences',
    title: 'Preferences',
    sub: 'Your sign-in details, what your role allows, and how this dashboard looks in this browser.',
  },
];

export const sectionByKey = (key: SectionKey): Section => SECTIONS.find((s) => s.key === key)!;
export const pathOf = (key: SectionKey): string => sectionByKey(key).path;

/**
 * Paths of the removed Eligible, Needs review and Excluded pages (D4: only the review queue is
 * stored per coin). Old links land on Data, which counts those coins and their reasons.
 */
export const RETIRED_SHEET_PATHS = ['eligible', 'needs-review', 'excluded'] as const;

export type CoinTab = 'review' | 'agent' | 'history' | 'details';
/** /coins/:cmcId with optional batch and detail tab. */
export function coinPath(
  cmcId: number,
  opts: { batch?: string | null; tab?: CoinTab | null } = {},
): string {
  const q = new URLSearchParams();
  if (opts.tab && opts.tab !== 'review') q.set('tab', opts.tab);
  if (opts.batch) q.set('batch', opts.batch);
  const s = q.toString();
  return `/coins/${cmcId}${s ? `?${s}` : ''}`;
}

/** Old hash links (#queue, ?coin=123#queue) to the new paths. Returns null when nothing to redirect. */
export function legacyRedirect(loc: { hash: string; search: string }): string | null {
  const coin = Number(new URLSearchParams(loc.search).get('coin'));
  if (Number.isInteger(coin) && coin > 0) return coinPath(coin);
  const key = loc.hash.replace(/^#/, '');
  const s = SECTIONS.find((x) => x.key === key);
  return s ? s.path : null;
}

/**
 * Typed query-string state for list pages. `get` reads with a default; `set` merges changes,
 * drops defaults from the URL and replaces the history entry (typing in a filter does not flood
 * the back button) unless `push` is asked for.
 */
export function useQueryState<D extends Record<string, string>>(defaults: D) {
  const [params, setParams] = useSearchParams();
  const values = useMemo(() => {
    const out = { ...defaults } as Record<keyof D, string>;
    for (const k of Object.keys(defaults) as (keyof D)[]) {
      const v = params.get(String(k));
      if (v !== null) out[k] = v;
    }
    return out;
    // `defaults` is a literal per call site.
  }, [params]);
  const set = useCallback(
    (changes: Partial<Record<keyof D, string | number | null>>, opts: { push?: boolean } = {}) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes)) {
            const val = v === null || v === undefined ? '' : String(v);
            if (val === '' || val === defaults[k]) next.delete(k);
            else next.set(k, val);
          }
          return next;
        },
        { replace: !opts.push },
      );
    },
    [setParams],
  );
  return [values, set] as const;
}

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
  | 'chat'
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
    sub: 'Hourly Tier 1 screen of every listed coin. Research only: no buy signal, no order.',
  },
  {
    key: 'queue',
    group: 'screen',
    primary: true,
    path: '/queue',
    label: 'Review queue',
    title: 'Review queue',
    sub: 'Coins with unusual volume against their own history, ranked for human chart review.',
    counted: true,
  },
  {
    key: 'forward',
    group: 'screen',
    path: '/forward',
    label: 'Forward test',
    title: 'Forward test',
    sub: 'Legacy tracker of star events from before the LBank cutover, on CMC daily Highs. Takes no new events.',
    counted: true,
  },
  {
    key: 'observation',
    group: 'screen',
    primary: true,
    path: '/lbank-spot',
    label: 'LBank',
    title: 'LBank price observation',
    sub: 'Each star event since the cutover, followed for exactly 168 hours from its publication: LBank Spot from verified trades, LBank Futures from sampled snapshots, each against its own reference.',
    counted: true,
  },
  {
    key: 'chat',
    group: 'screen',
    path: '/chat',
    label: 'Claude chat',
    title: 'Claude chat',
    sub: 'Ask the analyst desk (risk manager, pro trader, market data analyst) about the stored data and the current strategy. Read-only.',
    permission: 'chat:use',
  },
  {
    key: 'data',
    group: 'data',
    path: '/data',
    label: 'Data',
    title: 'Data',
    sub: 'Batch quality, why coins are left out, tracker summaries and database storage.',
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

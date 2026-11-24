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
  | 'eligible'
  | 'needs_review'
  | 'excluded'
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
    key: 'eligible',
    group: 'screen',
    path: '/eligible',
    label: 'Eligible',
    title: 'Eligible',
    sub: 'Every coin that passes all hard filters, including 0-star coins and windows that failed.',
    counted: true,
  },
  {
    key: 'needs_review',
    group: 'screen',
    path: '/needs-review',
    label: 'Needs review',
    title: 'Needs review',
    sub: 'Missing or ambiguous inputs are never silently eligible. Open a coin to resolve its LBank mapping.',
    counted: true,
  },
  {
    key: 'excluded',
    group: 'screen',
    path: '/excluded',
    label: 'Excluded',
    title: 'Excluded',
    sub: 'Coins with at least one failed hard filter. Their windows are not evaluated.',
    counted: true,
  },
  {
    key: 'forward',
    group: 'screen',
    primary: true,
    path: '/forward',
    label: 'Forward test',
    title: 'Forward test',
    sub: 'The first priced 1, 2 and 3-star detection per coin, UTC day and star count, followed to the end of the UTC day containing detection + 168 h. The return is the highest later High against the detection price: not a trade, not realized profit.',
    counted: true,
  },
  {
    key: 'data',
    group: 'data',
    primary: true,
    path: '/data',
    label: 'Data',
    title: 'Data',
    sub: 'Data quality of the latest batch (quotes, LBank mapping and list, scan warnings, last export) and why coins are left out of the screen.',
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

/** The four Tier 1 result sheets and their API names. */
export const SHEETS = ['queue', 'eligible', 'needs_review', 'excluded'] as const;
export type SheetKey = (typeof SHEETS)[number];

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

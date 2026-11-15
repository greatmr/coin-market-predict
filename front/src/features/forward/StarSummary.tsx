// Results by star count: how many events, how many have a confirmed High, how many still wait for a
// check, and the peak return of active events (so far, lower bounds) apart from completed ones
// (FINAL only). An unconfirmed identification-day High is never in these numbers.
import { type Column, Stars, Table } from '../../components/ui';
import { fmtInt, fmtPct } from '../../lib/format';

import type { CohortGroup } from './types';

const group = (g: CohortGroup) => (g.group === 'all' ? <b>All</b> : <Stars n={Number(g.group)} />);
const pctOf = (v: string | null, n: number, lowerBound: boolean) =>
  n ? `${lowerBound ? '≥ ' : ''}${fmtPct(v)}` : '—';

const FULL: Column<CohortGroup>[] = [
  { label: 'Stars', render: group },
  { label: 'Events', num: true, render: (g) => fmtInt(g.events) },
  {
    label: 'Confirmed High',
    num: true,
    title: 'Events with a High confirmed after identification (any status)',
    render: (g) => fmtInt(g.confirmedHigh),
  },
  {
    label: 'Awaiting check',
    num: true,
    title:
      'Not checked yet: the identification day has not ended, or the daily check has not run since',
    render: (g) => fmtInt(g.awaitingCheck),
  },
  {
    label: 'Day 0 unconfirmed',
    num: true,
    title:
      'Only an identification-day High so far, not proven to come after identification (excluded)',
    render: (g) => fmtInt(g.day0Unconfirmed),
  },
  {
    label: 'Active',
    num: true,
    title: 'Open, tracking or awaiting the final day',
    render: (g) => fmtInt(g.pending),
  },
  {
    label: 'Active median',
    num: true,
    title:
      'Median peak return so far of active events with a confirmed High (lower bounds: the window is still open)',
    render: (g) => pctOf(g.activeReturns.median, g.activeReturns.n, true),
  },
  {
    label: 'Active mean',
    num: true,
    title: 'Mean peak return so far of active events with a confirmed High (lower bounds)',
    render: (g) => pctOf(g.activeReturns.mean, g.activeReturns.n, true),
  },
  {
    label: 'Completed',
    num: true,
    title:
      'Window closed: final (every day covered) · incomplete (a gap; its peak is a lower bound)',
    render: (g) => `${fmtInt(g.final)} · ${fmtInt(g.incomplete)}`,
  },
  {
    label: 'Final median',
    num: true,
    title: 'Median final peak return (FINAL events only)',
    render: (g) => pctOf(g.finalReturns.median, g.finalReturns.n, false),
  },
  {
    label: 'Final mean',
    num: true,
    title: 'Mean final peak return (FINAL events only)',
    render: (g) => pctOf(g.finalReturns.mean, g.finalReturns.n, false),
  },
  {
    label: 'Final P25 – P75',
    num: true,
    render: (g) =>
      g.finalReturns.n ? `${fmtPct(g.finalReturns.p25)} – ${fmtPct(g.finalReturns.p75)}` : '—',
  },
  {
    label: 'Correlated',
    title: 'Coins with several events, and overlapping same-coin windows',
    render: (g) =>
      `${fmtInt(g.correlation.assetsWithMultipleEvents)} coins · ${fmtInt(g.correlation.sameAssetOverlaps)} overlaps`,
  },
];

const COMPACT_KEYS = new Set([
  'Stars',
  'Events',
  'Confirmed High',
  'Awaiting check',
  'Active median',
  'Completed',
  'Final median',
]);
const COMPACT = FULL.filter((c) => COMPACT_KEYS.has(String(c.label)));

export default function StarSummary({
  groups,
  compact = false,
}: {
  groups: CohortGroup[];
  compact?: boolean;
}) {
  return (
    <Table
      cols={compact ? COMPACT : FULL}
      rows={groups}
      empty="No events yet."
      rowKey={(g) => g.group}
    />
  );
}

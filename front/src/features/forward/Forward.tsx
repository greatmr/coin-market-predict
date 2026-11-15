// Star Event Forward Test: summary tiles, star-group statistics, event list and rejected triggers.
// A descriptive measurement, not a trade or a signal (docs/forward-test.md). The event list's
// view, star filter, search and page live in the URL: /forward?view=final&stars=3&q=btc&page=2
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';

import { HBars } from '../../components/charts';
import { SearchField } from '../../components/icons';
import {
  Chip,
  CoinCell,
  type Column,
  Lab,
  LoadError,
  Pager,
  PointsCell,
  Stars,
  Table,
} from '../../components/ui';
import { api, apiPost, errorMessage } from '../../lib/api';
import { apiUrl } from '../../lib/config';
import { RUN, type StatusMap, reasonText } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtDay, fmtInt, fmtMult, fmtPct, fmtPrice, fmtTime, utc } from '../../lib/format';
import { useQueryState } from '../../lib/routes';
import { useApp } from '../../state/app';

import type {
  CohortGroup,
  EventView,
  ForwardEventRow,
  ForwardEventsPage,
  ForwardRejection,
  ForwardSummary,
  ForwardUpdateResult,
  PassStatus,
} from './types';

const FWD_STATUS: StatusMap = {
  OPEN: ['', 'Open'],
  TRACKING: ['accent', 'Tracking'],
  AWAITING_FINAL_DAY: ['warning', 'Awaiting final day'],
  FINAL: ['good', 'Final'],
  INCOMPLETE: ['serious', 'Incomplete'],
};
const FWD_PAGE = 100;
const FWD_FLAG_TEXT: Record<string, string> = {
  INCOMPLETE_DAY0: 'day 0 not provable',
  DAY0_UNRESOLVED: 'day 0 open',
  FINAL_DAY_PENDING: 'final day pending',
  HIGH_MISSING: 'High missing',
  HIGH_INVALID: 'High invalid',
  PEAK_TIE_UNOBSERVED_DAY0: 'tie with day 0',
  CONTRACT_EVIDENCE_CHANGED: 'contract changed',
};
const VIEWS: readonly (readonly [EventView, string])[] = [
  ['active', 'Active'],
  ['final', 'Final'],
  ['incomplete', 'Incomplete'],
  ['all', 'All'],
];
const STAR_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ['1', '1★'],
  ['2', '2★'],
  ['3', '3★'],
];
const EXPORT_FILES = [
  'workbook.xlsx',
  'events_final.csv',
  'events_active.csv',
  'cohort_summary.csv',
];

const isView = (v: string): v is EventView => VIEWS.some(([k]) => k === v);
const isStars = (v: string) => STAR_FILTERS.some(([k]) => k === v);

function fwdFlag(code: string): string {
  const [k = '', ...rest] = String(code).split(':');
  return `${FWD_FLAG_TEXT[k] || k.replace(/_/g, ' ').toLowerCase()}${rest.length ? ` ${rest.join(':')}` : ''}`;
}

function FwdReturn({ r }: { r: ForwardEventRow }) {
  const o = r.outcome;
  if (!o || o.peakReturnPct === null) return <span className="muted">—</span>;
  const exact = o.peakKind === 'EXACT';
  return (
    <span
      className={exact ? 'fwd-ret' : 'fwd-ret provisional'}
      title={
        exact
          ? 'Final: every included day covered. Highest later High ÷ detection price − 1.'
          : 'Provisional lower bound: the window is still open, the final day is pending or a day is not covered.'
      }
    >
      {`${exact ? '' : '≥ '}${fmtPct(o.peakReturnPct)}`}
    </span>
  );
}

function FwdPeak({ r }: { r: ForwardEventRow }) {
  const o = r.outcome;
  if (!o || !o.peakHighUsd) return <span className="muted">—</span>;
  return (
    <div className="fwd-peak">
      <b>{fmtPrice(o.peakHighUsd)}</b>
      <span
        className="muted small"
        title={
          o.peakTimePrecision === 'UTC_DAY'
            ? 'Only the UTC day of this High is known.'
            : 'Time of the High as published by the source.'
        }
      >
        {o.peakAt ? fmtTime(o.peakAt) : `${o.peakDate ? fmtDay(o.peakDate) : '—'}, time unknown`}
      </span>
      {o.extensionPeakFlag === 'TRUE' ? (
        <Chip title="Inside the end-of-day extension.">after 168 h</Chip>
      ) : o.extensionPeakFlag === 'UNKNOWN' ? (
        <Chip title="The time precision cannot show whether this came after 168 h.">168 h?</Chip>
      ) : null}
    </div>
  );
}

/** The scanner's 3d / 7d / 30d results at detection, compact (multiples, YES in colour). */
const FwdWindows = ({ r }: { r: ForwardEventRow }) => {
  const windows: [string, PassStatus, string | null][] = [
    ['3d', r.pass3d, r.multiple3d],
    ['7d', r.pass7d, r.multiple7d],
    ['30d', r.pass30d, r.multiple30d],
  ];
  return (
    <span className="fwd-windows">
      {windows.map(([d, status, m]) => (
        <span
          key={d}
          className={`pass ${status === 'YES' ? 'yes' : status === 'NO' ? 'no' : 'na'}`}
          title={`${d}: ${status}`}
        >
          <b>{status === 'N/A' ? 'N/A' : fmtMult(m)}</b>
        </span>
      ))}
    </span>
  );
};

const EVENT_COLS: Column<ForwardEventRow>[] = [
  { label: 'Coin', render: (r) => <CoinCell r={r} /> },
  { label: 'Stars', render: (r) => <Stars n={r.starCount} /> },
  {
    label: 'Points',
    num: true,
    title: 'Weighted points at detection (weighted_star_v1)',
    render: (r) => (
      <PointsCell
        points={r.weightedPassPoints}
        complete={r.scoreComplete}
        strength={r.weightedStrength}
      />
    ),
  },
  {
    label: 'Detected',
    render: (r) => (
      <span title={`${utc(r.detectedAt)} (UTC date ${r.detectedUtcDate})`}>
        {fmtTime(r.detectedAt)}
      </span>
    ),
  },
  {
    label: 'Price',
    num: true,
    title: 'CMC USD price of the qualifying scan: a reference, not a fill',
    render: (r) => fmtPrice(r.referencePriceUsd),
  },
  { label: 'Highest High', render: (r) => <FwdPeak r={r} /> },
  { label: 'Return', num: true, render: (r) => <FwdReturn r={r} /> },
  { label: 'Status', render: (r) => <Lab map={FWD_STATUS} k={r.status} /> },
  {
    label: 'Days',
    num: true,
    title: 'Included days with an eligible High / completed included days (8 in all)',
    render: (r) => (r.outcome ? `${r.outcome.coveredDays}/${r.outcome.completedDays}` : '0/0'),
  },
  {
    label: 'Window ends',
    render: (r) => (
      <span
        title={`168 h at ${utc(r.deadline168h)}; included until ${utc(r.evaluationEnd)} (${Number(r.effectiveHorizonHours).toFixed(1)} h)`}
      >
        {fmtTime(r.evaluationEnd)}
      </span>
    ),
  },
  {
    label: '3d · 7d · 30d',
    title: 'Scanner results at detection',
    render: (r) => <FwdWindows r={r} />,
  },
  {
    label: 'Notes',
    render: (r) => (
      <span className="chips">
        {r.qualityFlags.map((f) => (
          <Chip key={f} tone={/^(INCOMPLETE|HIGH_)/.test(f) ? 'warn' : undefined} title={f}>
            {fwdFlag(f)}
          </Chip>
        ))}
        {r.overlappingEventIds.length ? (
          <Chip title="Other events of this coin with overlapping windows: correlated, not independent.">
            {`${r.overlappingEventIds.length} overlapping`}
          </Chip>
        ) : null}
      </span>
    ),
  },
];

const COHORT_COLS: Column<CohortGroup>[] = [
  {
    label: 'Group',
    render: (g) => (g.group === 'all' ? <b>All</b> : <Stars n={Number(g.group)} />),
  },
  { label: 'Events', num: true, render: (g) => fmtInt(g.events) },
  { label: 'Coins', num: true, render: (g) => fmtInt(g.distinctAssets) },
  { label: 'Final', num: true, render: (g) => fmtInt(g.final) },
  { label: 'Pending', num: true, render: (g) => fmtInt(g.pending) },
  { label: 'Incomplete', num: true, render: (g) => fmtInt(g.incomplete) },
  { label: 'Median', num: true, render: (g) => fmtPct(g.finalReturns.median) },
  { label: 'Mean', num: true, render: (g) => fmtPct(g.finalReturns.mean) },
  {
    label: 'P25 – P75',
    num: true,
    render: (g) =>
      g.finalReturns.n ? `${fmtPct(g.finalReturns.p25)} – ${fmtPct(g.finalReturns.p75)}` : '—',
  },
  {
    label: 'Min – max',
    num: true,
    render: (g) =>
      g.finalReturns.n ? `${fmtPct(g.finalReturns.min)} – ${fmtPct(g.finalReturns.max)}` : '—',
  },
  {
    label: 'Correlated',
    title: 'Coins with several events, and overlapping same-coin windows',
    render: (g) =>
      `${fmtInt(g.correlation.assetsWithMultipleEvents)} coins · ${fmtInt(g.correlation.sameAssetOverlaps)} overlaps`,
  },
];

const GROUP_COLS: Column<CohortGroup>[] = [
  { label: 'Group', render: (g) => <b>{g.group}</b> },
  { label: 'Events', num: true, render: (g) => fmtInt(g.events) },
  { label: 'Coins', num: true, render: (g) => fmtInt(g.distinctAssets) },
  { label: 'Final', num: true, render: (g) => fmtInt(g.final) },
  { label: 'Pending', num: true, render: (g) => fmtInt(g.pending) },
  { label: 'Incomplete', num: true, render: (g) => fmtInt(g.incomplete) },
  {
    label: 'Median',
    num: true,
    title: 'Median final peak return (FINAL events only); mean, p25 and p75 are in the export',
    render: (g) => fmtPct(g.finalReturns.median),
  },
];

const REJECTION_COLS: Column<ForwardRejection>[] = [
  { label: 'Batch', render: (r) => fmtTime(r.slotTime) },
  {
    label: 'Coin',
    render: (r) =>
      r.cmcId ? `${r.symbol || ''} (${r.cmcId})` : <span className="muted">no CMC id</span>,
  },
  {
    label: 'Stars',
    render: (r) =>
      r.starCount >= 1 && r.starCount <= 3 ? <Stars n={r.starCount} /> : String(r.starCount),
  },
  {
    label: 'Reasons',
    render: (r) => (
      <span className="chips">
        {r.reasons.map((x) => (
          <Chip key={x} title={x}>
            {reasonText(x)}
          </Chip>
        ))}
      </span>
    ),
  },
];

/** 24 columns, one per UTC hour of detection. */
function HourColumns({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="fwd-hours">
      {values.map((v, h) => (
        <span key={h}>
          <b>
            <i
              title={`${String(h).padStart(2, '0')}:00 UTC: ${v} events`}
              style={{ height: `${Math.max(v ? 6 : 2, (v / max) * 100)}%` }}
            />
          </b>
          <small>{h % 6 === 0 ? String(h).padStart(2, '0') : ''}</small>
        </span>
      ))}
    </div>
  );
}

function Seg({
  label,
  items,
  value,
  onPick,
  attr,
}: {
  label: string;
  items: readonly (readonly [string, string])[];
  value: string;
  onPick: (v: string) => void;
  attr: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map(([v, text]) => (
        <button
          key={v}
          type="button"
          {...{ [`data-${attr}`]: v }}
          aria-pressed={value === v}
          onClick={() => onPick(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function SummaryTiles({ s }: { s: ForwardSummary }) {
  const by = s.counts.byStatus;
  const active = (by.OPEN ?? 0) + (by.TRACKING ?? 0) + (by.AWAITING_FINAL_DAY ?? 0);
  const last = s.lastUpdate;
  return (
    <div className="tiles">
      <div className="tile">
        <span className="tile-label">Events</span>
        <b>{fmtInt(s.counts.events)}</b>
        <span className="muted small">{`on ${fmtInt(s.counts.watchlistAssets)} coins`}</span>
      </div>
      <div className="tile">
        <span className="tile-label">Active · Final · Incomplete</span>
        <b>{`${fmtInt(active)} · ${fmtInt(by.FINAL)} · ${fmtInt(by.INCOMPLETE)}`}</b>
        <span className="muted small">{`${fmtInt(by.AWAITING_FINAL_DAY)} awaiting the final day`}</span>
      </div>
      <div className="tile">
        <span className="tile-label">Daily High update</span>
        <b>{last ? <Lab map={RUN} k={last.status} /> : 'Not yet'}</b>
        <span className="muted small">
          {last
            ? `${fmtAgo(last.startedAt)}, for ${fmtDay(last.updateDate)}`
            : 'after the first UTC day closes'}
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">High coverage</span>
        <b>{`${fmtInt(s.coverage.coveredDays)} / ${fmtInt(s.coverage.completedDays)} days`}</b>
        <span className="muted small">
          {`${fmtInt(s.coverage.missingDays)} missing, ${fmtInt(s.coverage.day0Unresolved)} with day 0 unproven`}
        </span>
      </div>
    </div>
  );
}

interface ForwardData {
  sum: ForwardSummary;
  ev: ForwardEventsPage;
  rej: ForwardRejection[];
  view: EventView;
  search: string;
}

export default function Forward() {
  const { can, openCoin, dataVersion, setNavCount } = useApp();
  const [query, setQuery] = useQueryState({ view: 'active', stars: '', q: '', page: '1' });
  const view: EventView = isView(query.view) ? query.view : 'active';
  const stars = isStars(query.stars) ? query.stars : '';
  const search = query.q.trim();
  const pageNum = Number(query.page);
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum - 1 : 0;

  const [searchText, setSearchText] = useState(query.q);
  const [data, setData] = useState<ForwardData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updating, setUpdating] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keep the box in step when the URL changes from outside (back button, a shared link).
  useEffect(() => {
    setSearchText((t) => (t.trim() === query.q.trim() ? t : query.q));
  }, [query.q]);

  const load = useCallback(async () => {
    const q = new URLSearchParams({
      view,
      limit: String(FWD_PAGE),
      offset: String(page * FWD_PAGE),
    });
    if (stars) q.set('stars', stars);
    if (search) q.set('search', search);
    try {
      const [sum, ev, rej] = await Promise.all([
        api<ForwardSummary>('forward'),
        api<ForwardEventsPage>(`forward/events?${q}`),
        api<ForwardRejection[]>('forward/rejections?limit=50'),
      ]);
      const by = sum.counts.byStatus;
      setNavCount('forward', (by.OPEN ?? 0) + (by.TRACKING ?? 0) + (by.AWAITING_FINAL_DAY ?? 0));
      setData({ sum, ev, rej, view, search });
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    }
  }, [view, stars, search, page, setNavCount]);

  useEffect(() => {
    void load();
  }, [dataVersion, load]);

  useEffect(() => () => clearTimeout(debounce.current), []);

  const onSearch = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setSearchText(v);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setQuery({ q: v.trim(), page: null }), 250);
  };

  const updateNow = async () => {
    setUpdating(true);
    try {
      const r = await apiPost<ForwardUpdateResult>('forward/update');
      if (!r.ok) toast(r.reason || 'The update did not run.', 'warning');
      else
        toast(
          `Highs updated: ${r.update?.outcomes?.versions ?? 0} outcomes changed, ${r.update?.newlyFinal ?? 0} newly final.`,
        );
      await load();
    } catch (err) {
      toast(`Update failed: ${errorMessage(err)}`, 'error');
    } finally {
      setUpdating(false);
    }
  };

  const s = data?.sum;
  const all = s ? s.cohort.find((g) => g.group === 'all') : undefined;
  const eventsEmpty = data?.search
    ? `No event matches “${data.search}”.`
    : data?.view === 'active'
      ? 'No active event. Eligible 1, 2 and 3-star coins of a published queue are recorded automatically.'
      : 'No events in this view.';

  return (
    <>
      <div>
        {s ? (
          <>
            {/* The synthetic-data banner is already shown for the whole dashboard. */}
            {s.warnings
              .filter((w) => !w.startsWith('SYNTHETIC'))
              .map((w, i) => (
                <div key={i} className="banner inline">
                  {w}
                </div>
              ))}
            <p className="muted small fwd-notice">{s.notice}</p>
          </>
        ) : null}
      </div>
      {s ? <SummaryTiles s={s} /> : <div className="tiles" />}
      <div className="panel">
        <div className="panel-head">
          <h2>Star groups</h2>
          <span className="hint">
            return statistics use FINAL events only; several events of one coin or one day are
            correlated
          </span>
        </div>
        <div className="table-wrap">
          {s ? <Table cols={COHORT_COLS} rows={s.cohort} rowKey={(g) => g.group} /> : null}
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>By pass pattern</h2>
            <span className="hint">
              3d / 7d / 30d at detection; median and mean of FINAL events
            </span>
          </div>
          <div className="table-wrap">
            {s ? (
              <Table
                cols={GROUP_COLS}
                rows={s.cohortByPattern || []}
                empty="No events yet."
                rowKey={(g) => g.group}
              />
            ) : null}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>By weighted points</h2>
            <span className="hint">complete scores in fixed bands; incomplete scores apart</span>
          </div>
          <div className="table-wrap">
            {s ? (
              <Table
                cols={GROUP_COLS}
                rows={s.cohortByPointsBand || []}
                empty="No events yet."
                rowKey={(g) => g.group}
              />
            ) : null}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Final peak return</h2>
            <span className="hint">all stars; display bins, not thresholds</span>
          </div>
          <div>
            {!s ? null : all && all.finalReturns.n ? (
              <HBars
                items={all.returnDistribution.map((b) => ({ label: b.label, value: b.count }))}
              />
            ) : (
              <div className="empty">
                No FINAL event yet: an event finishes the day after its window ends.
              </div>
            )}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Detection hour (UTC)</h2>
            <span className="hint">the later the signal, the shorter the end-of-day extension</span>
          </div>
          <div>
            {!s ? null : all && all.events ? (
              <HourColumns values={all.detectionHourUtc} />
            ) : (
              <div className="empty">No events yet.</div>
            )}
          </div>
        </div>
      </div>
      <div className="toolbar">
        <SearchField label="Filter events" value={searchText} onChange={onSearch} />
        <Seg
          label="Events"
          attr="view"
          items={VIEWS}
          value={view}
          onPick={(v) => setQuery({ view: v, page: null }, { push: true })}
        />
        <Seg
          label="Stars"
          attr="stars"
          items={STAR_FILTERS}
          value={stars}
          onPick={(v) => setQuery({ stars: v, page: null }, { push: true })}
        />
        <span className="row-actions">
          {s && can('exports:read')
            ? EXPORT_FILES.map((f) => (
                <a key={f} className="chip link-chip" href={apiUrl(`forward/export/${f}`)} download>
                  {f}
                </a>
              ))
            : null}
          {s && can('scan:operate') ? (
            <button
              type="button"
              className="btn"
              disabled={updating}
              onClick={() => void updateNow()}
            >
              Update Highs now
            </button>
          ) : null}
        </span>
      </div>
      <div className="panel flush">
        <div className="table-wrap">
          {error ? (
            <LoadError error={error} />
          ) : data ? (
            <Table
              cols={EVENT_COLS}
              rows={data.ev.rows}
              empty={eventsEmpty}
              onRow={(r) => openCoin(r.cmcId)}
              rowKey={(r, i) => r.eventId || i}
            />
          ) : null}
        </div>
      </div>
      <div className="pager">
        {data ? (
          <Pager
            page={page}
            pageSize={FWD_PAGE}
            total={data.ev.total}
            unit="events"
            onPage={(p) => setQuery({ page: p > 0 ? p + 1 : null }, { push: true })}
          />
        ) : null}
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Rejected triggers</h2>
          <span className="hint">queue rows that opened no priced event, with every reason</span>
        </div>
        <div className="table-wrap">
          {data ? (
            <Table
              cols={REJECTION_COLS}
              rows={data.rej}
              empty="No rejected trigger."
              rowKey={(r, i) => r.id || i}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

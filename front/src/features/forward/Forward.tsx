// Star Event Forward Test: summary tiles, results by stars, the event list with its High-check
// status, and rejected triggers. A descriptive measurement, not a trade or a signal
// (docs/forward-test.md). List state lives in the URL:
//   /forward?view=tracking&stars=3&result=CONFIRMED&sort=return&dir=desc&q=btc&page=2
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { RUN, reasonText } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtDay, fmtInt, fmtPct, fmtPrice, fmtTime, tz, utc } from '../../lib/format';
import { useQueryState } from '../../lib/routes';
import { useApp } from '../../state/app';

import StarSummary from './StarSummary';
import UpdatePanel, { checksLine } from './UpdatePanel';
import {
  CheckCell,
  FwdPeak,
  FwdReturn,
  FwdWindows,
  NotesCell,
  SortHead,
  WindowCell,
} from './cells';
import {
  CHECK,
  DAY0_EXPLAINED,
  FWD_STATUS,
  OVERLAP_EXPLAINED,
  RESULT_FILTERS,
  STATUS_FILTERS,
  utcMidnightLocal,
} from './labels';
import type {
  CohortGroup,
  EventSort,
  ForwardEventRow,
  ForwardEventsPage,
  ForwardRejection,
  ForwardSummary,
  ForwardUpdateResult,
} from './types';

const FWD_PAGE = 100;
const STAR_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ['1', '1★'],
  ['2', '2★'],
  ['3', '3★'],
];
const SORTS: readonly EventSort[] = [
  'detected',
  'return',
  'stars',
  'points',
  'multiple3d',
  'multiple7d',
  'multiple30d',
];
const EXPORT_FILES = [
  'workbook.xlsx',
  'events_final.csv',
  'events_active.csv',
  'cohort_summary.csv',
];

const isStars = (v: string) => STAR_FILTERS.some(([k]) => k === v);
const statusFilter = (v: string) => STATUS_FILTERS.find(([k]) => k === v) ?? STATUS_FILTERS[0]!;
const isResult = (v: string) => RESULT_FILTERS.some(([k]) => k === v);
const isSort = (v: string): v is EventSort => (SORTS as readonly string[]).includes(v);

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
  const good = s.lastSuccessfulUpdate;
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
      <div className="tile" title={last ? checksLine(last) : undefined}>
        <span className="tile-label">Last High check</span>
        <b>{last ? <Lab map={RUN} k={last.status} /> : 'Not yet'}</b>
        <span className="muted small">
          {last
            ? `${fmtAgo(last.startedAt)} (${last.trigger}), data through ${fmtDay(last.updateDate)} UTC`
            : 'after the first UTC day closes'}
        </span>
        {good && good.id !== last?.id ? (
          <span className="muted small">{`last successful ${fmtAgo(good.finishedAt)}`}</span>
        ) : null}
        {last?.checks ? (
          <span className="muted small">
            {`${fmtInt(last.checks.newRecord)} new · ${fmtInt(last.checks.unchanged)} unchanged · ${fmtInt(last.checks.dataUnavailable + last.checks.errors)} without data`}
          </span>
        ) : null}
      </div>
      <div className="tile">
        <span className="tile-label">High coverage</span>
        <b>{`${fmtInt(s.coverage.coveredDays)} / ${fmtInt(s.coverage.completedDays)} days`}</b>
        <span className="muted small">
          {`${fmtInt(s.coverage.missingDays)} missing, ${fmtInt(s.coverage.day0Unresolved)} with day 0 unconfirmed`}
        </span>
      </div>
    </div>
  );
}

/** Definitions behind every column: Return, the window, days and time zones, checks, notes. */
function HowToRead({ s }: { s: ForwardSummary | undefined }) {
  return (
    <details className="panel rules">
      <summary>
        <h2>How to read the forward test</h2>
        <span className="hint">Return, days and time zones, High checks, notes</span>
      </summary>
      <div>
        <ul className="rule-list fwd-defs">
          <li>
            <b>Return</b> is the peak return: the highest High confirmed after identification ÷ the
            CMC price recorded at identification − 1. It is the maximum price increase, not trading
            profit: the price may have hit a stop before it rose. A value with ≥ is so far (the
            window is still open or a day is missing); FINAL values are exact.
          </li>
          <li>
            <b>Window.</b> 168 hours from identification, checked through the end of the UTC day in
            which those 168 hours expire. {s ? s.horizon.days : ''}
          </li>
          <li>
            <b>Time zones.</b>{' '}
            {`Days are counted in UTC. Times on this page are shown in ${tz()}, where a UTC day starts at ${utcMidnightLocal()}. Hover a time for its UTC value.`}
          </li>
          <li>
            <b>Window column.</b> “Day 3 of 7” is the UTC day the window is in now (day 0 = the
            identification date). “2 of 3 closed days checked” counts the ended UTC days of the
            window that have a usable daily High stored, from day 0 on.
          </li>
          <li>
            <b>When Highs are checked.</b> Once per closed UTC day, by the first hourly run after
            00:00 UTC; again every few hours while a closed day&apos;s High is missing; and when
            someone clicks <i>Update Highs now</i>. Never when the page opens, and never by the
            hourly scan itself. The High check column shows each event&apos;s last check and the
            date it is checked through; the tile above shows the last run.
          </li>
          <li>
            <b>High check results.</b>{' '}
            {(
              [
                'NOT_CHECKED',
                'NEW_RECORD',
                'UNCHANGED',
                'DATA_UNAVAILABLE',
                'RETRIEVAL_ERROR',
              ] as const
            )
              .map((k) => `${CHECK[k][1]}: ${CHECK[k][2]}`)
              .join(' ')}
          </li>
          <li>
            <b>Highest High time</b> is when the price reached that High, as published by CMC
            (timeHigh, minute precision), not when it was retrieved or checked. Highs come only from
            the coin&apos;s CMC USD daily OHLC: never Close, sampled prices or LBank.
          </li>
          <li>
            <b>Day 0 (yellow).</b> {DAY0_EXPLAINED}
          </li>
          <li>
            <b>Overlapping.</b> {OVERLAP_EXPLAINED}
          </li>
          <li>
            <b>At identification.</b> Stars, points and the 3d / 7d / 30d ratios are recorded when
            the coin is identified and never change. The coin page shows its current values.
          </li>
          <li>
            <b>Duplicates.</b> One event per coin, UTC day and star count: the same stars again that
            day add nothing; a different star count opens its own event.
          </li>
        </ul>
      </div>
    </details>
  );
}

interface ForwardData {
  sum: ForwardSummary;
  ev: ForwardEventsPage;
  rej: ForwardRejection[];
  search: string;
  filtered: boolean;
}

export default function Forward() {
  const { can, openCoin, dataVersion, setNavCount } = useApp();
  const [query, setQuery] = useQueryState({
    view: 'active',
    stars: '',
    result: '',
    sort: 'detected',
    dir: 'desc',
    q: '',
    page: '1',
  });
  const [statusKey, , statusApi] = statusFilter(query.view);
  const stars = isStars(query.stars) ? query.stars : '';
  const result = isResult(query.result) ? query.result : '';
  const sort: EventSort = isSort(query.sort) ? query.sort : 'detected';
  const dir = query.dir === 'asc' ? 'asc' : 'desc';
  const search = query.q.trim();
  const pageNum = Number(query.page);
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum - 1 : 0;

  const [searchText, setSearchText] = useState(query.q);
  const [data, setData] = useState<ForwardData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updateRunId, setUpdateRunId] = useState<string | null>(null);
  const [checkRunning, setCheckRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keep the box in step when the URL changes from outside (back button, a shared link).
  useEffect(() => {
    setSearchText((t) => (t.trim() === query.q.trim() ? t : query.q));
  }, [query.q]);

  const load = useCallback(async () => {
    const q = new URLSearchParams({
      view: statusApi.view,
      sort,
      dir,
      limit: String(FWD_PAGE),
      offset: String(page * FWD_PAGE),
    });
    if (statusApi.status) q.set('status', statusApi.status);
    if (stars) q.set('stars', stars);
    if (result) q.set('result', result);
    if (search) q.set('search', search);
    try {
      const [sum, ev, rej] = await Promise.all([
        api<ForwardSummary>('forward'),
        api<ForwardEventsPage>(`forward/events?${q}`),
        api<ForwardRejection[]>('forward/rejections?limit=50'),
      ]);
      const by = sum.counts.byStatus;
      setNavCount('forward', (by.OPEN ?? 0) + (by.TRACKING ?? 0) + (by.AWAITING_FINAL_DAY ?? 0));
      setData({
        sum,
        ev,
        rej,
        search,
        filtered: statusKey !== 'active' || !!stars || !!result,
      });
      // Follow a check that is already running (the hourly run's, or one started elsewhere).
      if (sum.lastUpdate?.status === 'running') {
        const runningId = sum.lastUpdate.id;
        setUpdateRunId((id) => id ?? runningId);
        setCheckRunning(true);
      }
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    }
  }, [statusApi, statusKey, stars, result, sort, dir, search, page, setNavCount]);

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

  const onSort = useCallback(
    (k: EventSort) =>
      setQuery(
        { sort: k, dir: k === sort && dir === 'desc' ? 'asc' : 'desc', page: null },
        { push: true },
      ),
    [sort, dir, setQuery],
  );

  const updateNow = async () => {
    setStarting(true);
    try {
      const r = await apiPost<ForwardUpdateResult>('forward/update');
      if (r.ok && r.updateRunId) {
        setUpdateRunId(r.updateRunId);
        setCheckRunning(true);
      } else
        toast(
          `The High check did not start: ${r.reason || 'unknown reason'}. The hourly run may be using the pipeline; try again in a few minutes.`,
          'warning',
        );
    } catch (err) {
      toast(`The High check did not start: ${errorMessage(err)}`, 'error');
    } finally {
      setStarting(false);
    }
  };

  const cols = useMemo<Column<ForwardEventRow>[]>(() => {
    const head = (k: EventSort, label: string) => (
      <SortHead k={k} label={label} sort={sort} dir={dir} onSort={onSort} />
    );
    return [
      { label: 'Coin', render: (r) => <CoinCell r={r} /> },
      { label: head('stars', 'Stars'), render: (r) => <Stars n={r.starCount} /> },
      {
        label: head('points', 'Points'),
        num: true,
        title: 'Weighted points at identification (weighted_star_v1); never updated',
        render: (r) => (
          <PointsCell
            points={r.weightedPassPoints}
            complete={r.scoreComplete}
            strength={r.weightedStrength}
          />
        ),
      },
      {
        label: head('detected', 'Identified'),
        render: (r) => (
          <span title={`${utc(r.detectedAt)} (UTC date ${r.detectedUtcDate}, day 0)`}>
            {fmtTime(r.detectedAt)}
          </span>
        ),
      },
      {
        label: 'Price',
        num: true,
        title:
          'CMC USD price recorded at identification: fixed for the event, a reference, not a fill',
        render: (r) => fmtPrice(r.referencePriceUsd),
      },
      { label: 'Highest High', render: (r) => <FwdPeak r={r} /> },
      { label: head('return', 'Return'), num: true, render: (r) => <FwdReturn r={r} /> },
      { label: 'Status', render: (r) => <Lab map={FWD_STATUS} k={r.status} /> },
      {
        label: 'High check',
        title: 'Result of the last check, the UTC date it is checked through and when it ran',
        render: (r) => <CheckCell r={r} />,
      },
      {
        label: 'Window (UTC days)',
        title: 'Day 0 = UTC date of identification … day 7 = UTC date of identification + 168 h',
        render: (r) => <WindowCell r={r} />,
      },
      {
        label: (
          <span className="sort-group" title="Ratios at identification (current VMC ÷ mean)">
            {head('multiple3d', '3d')}
            {head('multiple7d', '7d')}
            {head('multiple30d', '30d')}
          </span>
        ),
        render: (r) => <FwdWindows r={r} />,
      },
      { label: 'Notes', render: (r) => <NotesCell r={r} /> },
    ];
  }, [sort, dir, onSort]);

  const s = data?.sum;
  const all = s ? s.cohort.find((g) => g.group === 'all') : undefined;
  const eventsEmpty = data?.search
    ? `No event matches “${data.search}”.`
    : data?.filtered
      ? 'No events match these filters.'
      : 'No active event. Eligible 1, 2 and 3-star coins of a published queue are recorded automatically.';

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
      {updateRunId ? (
        <UpdatePanel
          key={updateRunId}
          runId={updateRunId}
          onFinished={() => {
            setCheckRunning(false);
            void load();
          }}
          onDismiss={() => setUpdateRunId(null)}
        />
      ) : null}
      <div className="panel">
        <div className="panel-head">
          <h2>Results by stars</h2>
          <span className="hint">
            active returns are so far (≥); final statistics use FINAL events only; an unconfirmed
            day-0 High is never counted
          </span>
        </div>
        <div className="table-wrap">{s ? <StarSummary groups={s.cohort} /> : null}</div>
      </div>
      <HowToRead s={s} />
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>By pass pattern</h2>
            <span className="hint">3d / 7d / 30d at identification; median of FINAL events</span>
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
            <h2>Identification hour (UTC)</h2>
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
        <label className="select-field">
          <span>Status</span>
          <select
            value={statusKey}
            onChange={(e) => setQuery({ view: e.target.value, page: null }, { push: true })}
          >
            {STATUS_FILTERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="select-field">
          <span>Result</span>
          <select
            value={result}
            onChange={(e) => setQuery({ result: e.target.value, page: null }, { push: true })}
          >
            {RESULT_FILTERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
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
              disabled={starting || checkRunning}
              title="Check every active event's daily Highs now. Progress and the result appear above the table."
              onClick={() => void updateNow()}
            >
              {starting ? 'Starting…' : 'Update Highs now'}
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
              cols={cols}
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

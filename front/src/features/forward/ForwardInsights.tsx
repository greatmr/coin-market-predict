// Star Event Forward Test summary, moved off the Events page onto the Data page: tiles, results by
// stars, cohort breakdowns, rejected triggers, how to read it, and the High-check controls.
// A descriptive measurement, not a trade or a signal (docs/forward-test.md).
import { useCallback, useEffect, useState } from 'react';

import { HBars } from '../../components/charts';
import {
  Chip,
  type Column,
  Lab,
  SkeletonBlock,
  SkeletonTable,
  SkeletonTiles,
  Stars,
  Table,
} from '../../components/ui';
import { api, apiPost, errorMessage } from '../../lib/api';
import { apiUrl } from '../../lib/config';
import { RUN, reasonText } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtDay, fmtInt, fmtPct, fmtTime, tz } from '../../lib/format';
import { useApp } from '../../state/app';

import StarSummary from './StarSummary';
import UpdatePanel, { checksLine } from './UpdatePanel';
import {
  AVERAGE_RETURN_EXPLAINED,
  CHECK,
  DAY0_EXPLAINED,
  LISTINGS_EXPLAINED,
  OVERLAP_EXPLAINED,
  utcMidnightLocal,
} from './labels';
import type { CohortGroup, ForwardRejection, ForwardSummary, ForwardUpdateResult } from './types';

const EXPORT_FILES = ['events_final.csv', 'events_active.csv', 'cohort_summary.csv'];

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
            <b>Average Return (coin).</b> {AVERAGE_RETURN_EXPLAINED}
          </li>
          <li>
            <b>LBank Spot / Futures and Bithumb.</b> {LISTINGS_EXPLAINED}
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

export default function ForwardInsights() {
  const { can, dataVersion, setNavCount } = useApp();
  const [s, setS] = useState<ForwardSummary | null>(null);
  const [rej, setRej] = useState<ForwardRejection[] | null>(null);
  const [updateRunId, setUpdateRunId] = useState<string | null>(null);
  const [checkRunning, setCheckRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [sum, r] = await Promise.all([
        api<ForwardSummary>('forward'),
        api<ForwardRejection[]>('forward/rejections?limit=50'),
      ]);
      const by = sum.counts.byStatus;
      setNavCount('forward', (by.OPEN ?? 0) + (by.TRACKING ?? 0) + (by.AWAITING_FINAL_DAY ?? 0));
      setS(sum);
      setRej(r);
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
  }, [setNavCount]);

  useEffect(() => {
    void load();
  }, [dataVersion, load]);

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

  const all = s ? s.cohort.find((g) => g.group === 'all') : undefined;

  return (
    <>
      <div className="panel-head">
        <h2>Star Event Forward Test</h2>
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
              title="Check every active event's daily Highs now. Progress and the result appear below."
              onClick={() => void updateNow()}
            >
              {starting ? 'Starting…' : 'Update Highs now'}
            </button>
          ) : null}
        </span>
      </div>
      {error ? <div className="banner inline">{errorMessage(error)}</div> : null}
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
          <SummaryTiles s={s} />
        </>
      ) : (
        <div className="tiles">
          <SkeletonTiles />
        </div>
      )}
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
        <div className="table-wrap">
          {s ? <StarSummary groups={s.cohort} /> : <SkeletonTable rows={4} />}
        </div>
      </div>
      <HowToRead s={s ?? undefined} />
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
            ) : (
              <SkeletonTable rows={5} />
            )}
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
            ) : (
              <SkeletonTable rows={5} />
            )}
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
            {!s ? (
              <SkeletonBlock height={180} />
            ) : all && all.finalReturns.n ? (
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
            {!s ? (
              <SkeletonBlock height={128} />
            ) : all && all.events ? (
              <HourColumns values={all.detectionHourUtc} />
            ) : (
              <div className="empty">No events yet.</div>
            )}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Rejected triggers</h2>
          <span className="hint">queue rows that opened no priced event, with every reason</span>
        </div>
        <div className="table-wrap">
          {rej ? (
            <Table
              cols={REJECTION_COLS}
              rows={rej}
              empty="No rejected trigger."
              rowKey={(r, i) => r.id || i}
            />
          ) : (
            <SkeletonTable rows={3} />
          )}
        </div>
      </div>
    </>
  );
}

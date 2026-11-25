// Star Event Forward Test summary, moved off the Events page onto the Data page: tiles, results by
// stars, cohort breakdowns, rejected triggers, how to read it, and the High-check controls.
// A descriptive measurement, not a trade or a signal (docs/forward-test.md).
import { useCallback, useEffect, useState } from 'react';

import { HelpButton } from '../../components/Help';
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
import { fmtAgo, fmtDay, fmtInt, fmtPct, fmtTime } from '../../lib/format';
import { useApp } from '../../state/app';

import StarSummary from './StarSummary';
import UpdatePanel, { checksLine } from './UpdatePanel';
import { warningText } from './labels';
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
          <Chip key={x}>{reasonText(x)}</Chip>
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
        <h2>Forward test (legacy)</h2>
        <HelpButton topic="forwardResults" />
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
                {warningText(w)}
              </div>
            ))}
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

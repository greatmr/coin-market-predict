// LBank Spot Price Observation summary, kept on the Data page (the LBank Spot page has only the
// table and its filters): the cutover, counts with their denominators, final-only statistics by
// stars and by Spot / Futures class, the legacy wind-down, the export and "Update now".
import { useCallback, useEffect, useState } from 'react';

import { HelpButton } from '../../components/Help';
import { type Column, Lab, SkeletonTable, SkeletonTiles, Table } from '../../components/ui';
import { api, apiPost, errorMessage } from '../../lib/api';
import { apiUrl } from '../../lib/config';
import { type StatusMap, humanize, triggerText } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtInt, fmtPct, fmtTime, utc } from '../../lib/format';
import { useApp } from '../../state/app';

import type { LegacyStatus, ObservationSummary, StatsJson } from './types';

const RUN_STATUS: StatusMap = {
  running: ['accent', 'Running'],
  succeeded: ['good', 'Succeeded'],
  partial: ['warning', 'Partial'],
  failed: ['critical', 'Failed'],
};

interface StatRow {
  key: string;
  label: string;
  events: number;
  coins: number;
  rise: StatsJson;
  drop: StatsJson;
}

const pct = (v: string | null) => (v === null ? '—' : fmtPct(v));
const range = (s: StatsJson) => (s.n ? `${pct(s.p25)} … ${pct(s.p75)}` : '—');

const STAT_COLS: Column<StatRow>[] = [
  { label: 'Group', render: (g) => <b>{g.label}</b> },
  { label: 'Final events', num: true, render: (g) => fmtInt(g.events) },
  {
    label: 'Coins',
    num: true,
    title: "Distinct coins: one coin's events follow one price path",
    render: (g) => fmtInt(g.coins),
  },
  { label: 'Max rise, median', num: true, render: (g) => pct(g.rise.median) },
  {
    label: 'Max rise, middle half',
    num: true,
    title: '25th to 75th percentile',
    render: (g) => range(g.rise),
  },
  { label: 'Max drop, median', num: true, render: (g) => pct(g.drop.median) },
  {
    label: 'Max drop, middle half',
    num: true,
    title: '25th to 75th percentile',
    render: (g) => range(g.drop),
  },
];

function Tiles({ s }: { s: ObservationSummary }) {
  const f = s.summary.final;
  const c = s.summary.correlation;
  return (
    <div className="tiles">
      <div className="tile">
        <span className="tile-label">Cutover (UTC)</span>
        <b>{s.cutover.cutoverAt ? utc(s.cutover.cutoverAt) : 'Not set'}</b>
        <span className="muted small">
          {s.cutover.cutoverAt
            ? s.cutover.passed
              ? 'New star events are observed here'
              : 'Not reached: new events still go to the forward test'
            : 'Not set yet: every star event goes to the forward test'}
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">Observations</span>
        <b>{`${fmtInt(s.summary.total.events)} events`}</b>
        <span className="muted small">
          {`on ${fmtInt(s.summary.total.coins)} coins · ${fmtInt(c.overlappingPairs)} overlapping pairs`}
        </span>
      </div>
      <div className="tile" title="Every statistic below uses Final observations only">
        <span className="tile-label">Final</span>
        <b>{`${fmtInt(f.events)} events · ${fmtInt(f.coins)} coins`}</b>
        <span className="muted small">
          {`provisional ${fmtInt(s.summary.provisional.events)} · not measurable ${fmtInt(s.summary.unmeasured.events)}`}
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">Last update</span>
        <b>{s.lastRun ? <Lab map={RUN_STATUS} k={s.lastRun.status} /> : 'Not yet'}</b>
        <span className="muted small">
          {s.lastRun
            ? `${fmtAgo(s.lastRun.startedAt)}, ${triggerText(s.lastRun.trigger)}`
            : 'runs every 15 minutes'}
          {s.lastSuccessfulRunAt && s.lastRun?.status !== 'succeeded'
            ? ` · last successful ${fmtAgo(s.lastSuccessfulRunAt)}`
            : ''}
        </span>
      </div>
    </div>
  );
}

function legacyLine(l: LegacyStatus): string | null {
  if (l.state === 'retired')
    return `Forward test retired: ${fmtInt(l.events)} events — ${fmtInt(l.closures.FINAL)} final, ${fmtInt(l.closures.INCOMPLETE)} incomplete, ${fmtInt(l.closures.DATA_UNAVAILABLE)} without data.`;
  if (l.state === 'closing')
    return `Forward test finishing: ${fmtInt(l.pending)} of ${fmtInt(l.events)} earlier events still open${l.pendingUntil ? `, all done by ${fmtTime(l.pendingUntil)}` : ''}.`;
  return null;
}

export default function ObservationInsights() {
  const { can, dataVersion } = useApp();
  const [s, setS] = useState<ObservationSummary | null>(null);
  const [legacy, setLegacy] = useState<LegacyStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sum, leg] = await Promise.all([
        api<ObservationSummary>('observations/summary'),
        api<LegacyStatus>('forward/legacy').catch(() => null),
      ]);
      setS(sum);
      setLegacy(leg);
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [dataVersion, load]);

  const runNow = async () => {
    setStarting(true);
    try {
      const r = await apiPost<{ ok: boolean; reason?: string }>('observations/update');
      if (r.ok) toast('The LBank observation update started; results refresh with the next poll.');
      else toast(`The update did not start: ${r.reason ?? 'unknown reason'}.`, 'warning');
    } catch (err) {
      toast(`The update did not start: ${errorMessage(err)}`, 'error');
    } finally {
      setStarting(false);
    }
  };

  const f = s?.summary.final;
  const rows: StatRow[] = f
    ? [
        { key: 'all', label: 'All', events: f.events, coins: f.coins, rise: f.rise, drop: f.drop },
        ...f.byStars
          .filter((g) => g.events)
          .map((g) => ({ ...g, key: `s${g.key}`, label: `${g.key}★` })),
        ...f.byEligibility
          .filter((g) => g.events)
          .map((g) => ({ ...g, key: `e${g.key}`, label: g.label || humanize(g.key) })),
      ]
    : [];
  const leg = legacy ? legacyLine(legacy) : null;

  return (
    <>
      <div className="panel-head">
        <h2>LBank Spot observation</h2>
        <HelpButton topic="observationResults" />
        <span className="row-actions">
          {s && can('exports:read') ? (
            <a className="chip link-chip" href={apiUrl('observations/export.csv')} download>
              Export CSV
            </a>
          ) : null}
          {s && can('scan:operate') ? (
            <button
              type="button"
              className="btn"
              disabled={starting}
              title="Fetch the latest LBank candles and recompute every open observation now"
              onClick={() => void runNow()}
            >
              {starting ? 'Starting…' : 'Update now'}
            </button>
          ) : null}
        </span>
      </div>
      {error ? <div className="banner inline">{errorMessage(error)}</div> : null}
      {s ? (
        <Tiles s={s} />
      ) : (
        <div className="tiles">
          <SkeletonTiles />
        </div>
      )}
      <div className="panel">
        <div className="panel-head">
          <h2>Results of Final observations</h2>
          <span className="hint">two independent price extremes on LBank Spot, not profit</span>
        </div>
        <div className="table-wrap">
          {s ? (
            <Table
              cols={STAT_COLS}
              rows={rows.filter((r) => r.events)}
              empty="No Final observation yet: an observation is Final once its 168 hours have passed with every minute present."
              rowKey={(r) => r.key}
            />
          ) : (
            <SkeletonTable rows={4} />
          )}
        </div>
        {leg ? <p className="muted small">{leg}</p> : null}
      </div>
    </>
  );
}

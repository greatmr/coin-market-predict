// LBank Spot price observation summary, kept on the Data page (the LBank Spot page has only the
// table and its filters): the cutover, counts with their denominators, Final-only statistics of the
// highest and lowest return by stars and by Spot / Futures evidence class, data freshness (not the
// recompute time), the legacy wind-down, the export and "Update now" with what it actually did.
import { useCallback, useEffect, useState } from 'react';

import { HelpButton } from '../../components/Help';
import { type Column, Lab, SkeletonTable, SkeletonTiles, Table } from '../../components/ui';
import { api, apiPost, errorMessage } from '../../lib/api';
import { apiUrl } from '../../lib/config';
import { type StatusMap, humanize, triggerText } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtInt, fmtPct, fmtSpan, fmtTime, utc } from '../../lib/format';
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
  highest: StatsJson;
  lowest: StatsJson;
}

const pct = (v: string | null) => (v === null ? '—' : fmtPct(v));
const range = (s: StatsJson) => (s.n ? `${pct(s.p25)} … ${pct(s.p75)}` : '—');

const STAT_COLS: Column<StatRow>[] = [
  { label: 'Group', render: (g) => <b>{g.label}</b> },
  { label: 'Final events', num: true, render: (g) => fmtInt(g.events) },
  {
    label: 'Coins',
    num: true,
    title: "Distinct coins: one coin's overlapping events follow one price path (correlated)",
    render: (g) => fmtInt(g.coins),
  },
  {
    label: 'Highest return, median',
    num: true,
    title: 'Maximum rise vs the reference trade (≥ 0); not profit',
    render: (g) => pct(g.highest.median),
  },
  {
    label: 'Highest, middle half',
    num: true,
    title: '25th to 75th percentile',
    render: (g) => range(g.highest),
  },
  {
    label: 'Lowest return, median',
    num: true,
    title: 'Maximum decline vs the reference trade (≤ 0); not a stop loss',
    render: (g) => pct(g.lowest.median),
  },
  {
    label: 'Lowest, middle half',
    num: true,
    title: '25th to 75th percentile',
    render: (g) => range(g.lowest),
  },
];

function lastRunText(s: ObservationSummary): string {
  const r = s.lastRun;
  if (!r) return 'runs every 15 minutes';
  const did =
    r.fetchedNewData === null
      ? ''
      : r.fetchedNewData
        ? ` · fetched ${fmtInt(r.candlesStored ?? 0)} candles, ${fmtInt(r.tradeMinutesChecked ?? 0)} trade minutes`
        : ' · no new LBank data: recomputed only';
  return `${fmtAgo(r.startedAt)}, ${triggerText(r.trigger)}${did}`;
}

function Tiles({ s }: { s: ObservationSummary }) {
  const f = s.summary.final;
  const c = s.summary.correlation;
  const fr = s.freshness;
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
      <div
        className="tile"
        title="Every statistic below uses Final observations of the current rules only"
      >
        <span className="tile-label">{`Final (${s.rulesVersion})`}</span>
        <b>{`${fmtInt(f.events)} events · ${fmtInt(f.coins)} coins`}</b>
        <span className="muted small">
          {`${fmtInt(f.flagged.singleTrade.events)} with a thin-market extreme · ${fmtInt(f.flagged.delayedReference.events)} delayed (kept)`}
        </span>
      </div>
      <div className="tile" title="Never in a statistic">
        <span className="tile-label">Not in the statistics</span>
        <b>{`${fmtInt(s.summary.provisional.events)} active`}</b>
        <span className="muted small">
          {`${fmtInt(s.summary.partial.events)} partial · ${fmtInt(s.summary.noTrades.events)} no trades · ${fmtInt(s.summary.unverifiable.events)} unverifiable · ${fmtInt(s.summary.unmeasured.events)} not measurable`}
        </span>
      </div>
      <div
        className="tile"
        title="How current the LBank data is, independent of when the job last ran or recomputed"
      >
        <span className="tile-label">Data freshness</span>
        <b>
          {fr.oldestOpenLagMs === null
            ? 'No open window'
            : `${fmtSpan(fr.oldestOpenLagMs / 1000)} behind`}
        </b>
        <span className="muted small">
          {`oldest open window through ${fr.oldestOpenDataThrough ? fmtTime(fr.oldestOpenDataThrough) : '—'} · last LBank fetch ${fmtAgo(fr.lastSourceFetchAt)}${fr.pairsWithFetchErrors ? ` · ${fr.pairsWithFetchErrors} pairs failing` : ''}${fr.observationsAwaitingVerification ? ` · ${fr.observationsAwaitingVerification} awaiting trade checks` : ''}`}
        </span>
      </div>
      <div
        className="tile"
        title={`Futures side (${s.futures.rulesVersion}): sampled snapshots, never in the Spot statistics. ${s.futures.priceSource}`}
      >
        <span className="tile-label">Futures (first observed price)</span>
        <b>{`${fmtInt(s.futures.byMethod.OBSERVED_QUOTE.ACTIVE ?? 0)} active · ${fmtInt(s.futures.byMethod.OBSERVED_QUOTE.CLOSED ?? 0)} closed`}</b>
        <span className="muted small">
          {`observed-quote method only; older method apart: ${fmtInt(Object.values(s.futures.byMethod.LEGACY_TURNOVER_BRACKET).reduce((a, n) => a + (n ?? 0), 0))} rows (${fmtInt(s.futures.byMethod.LEGACY_TURNOVER_BRACKET.HISTORY_UNAVAILABLE ?? 0)} not sampled at start) · last snapshot ${s.futures.lastPoll ? `${fmtAgo(s.futures.lastPoll.fetchedAt)}${s.futures.lastPoll.ok ? '' : ' (failed)'}` : 'none'}`}
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">Last update</span>
        <b>{s.lastRun ? <Lab map={RUN_STATUS} k={s.lastRun.status} /> : 'Not yet'}</b>
        <span className="muted small">
          {lastRunText(s)}
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
      if (r.ok)
        toast(
          'The LBank observation update started; “Last update” shows whether it fetched new data or only recomputed.',
        );
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
        {
          key: 'all',
          label: 'All',
          events: f.events,
          coins: f.coins,
          highest: f.highest,
          lowest: f.lowest,
        },
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
        <h2>LBank Spot price observation</h2>
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
              title="Fetch the latest LBank candles and trades and recompute every open observation now"
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
          <SkeletonTiles n={6} />
        </div>
      )}
      <div className="panel">
        <div className="panel-head">
          <h2>Results of Final observations</h2>
          <span className="hint">
            two independent price extremes on LBank Spot vs the first trade after the signal, never
            summed, not profit
          </span>
        </div>
        <div className="table-wrap">
          {s ? (
            <Table
              cols={STAT_COLS}
              rows={rows.filter((r) => r.events)}
              empty="No Final observation yet: an observation is Final once its 168 hours have passed and every minute and deciding trade is verified."
              rowKey={(r) => r.key}
            />
          ) : (
            <SkeletonTable rows={4} />
          )}
        </div>
        {s && f && f.events ? (
          <p className="muted small">
            {`Each event counts once (${fmtInt(f.events)} events on ${fmtInt(f.coins)} coins). Events of one coin whose windows overlap follow the same price path, so they are correlated, not independent; no coin-level weighting is applied.`}
          </p>
        ) : null}
        {leg ? <p className="muted small">{leg}</p> : null}
      </div>
    </>
  );
}

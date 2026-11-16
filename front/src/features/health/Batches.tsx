// Runs & health: source tiles, the latest run as a Gantt, hourly crawl batches, pipeline runs and
// open LBank mapping tasks.
import { type PointerEvent, useCallback, useEffect, useState } from 'react';

import { TipHead, TipRow } from '../../components/Feedback';
import { ChartBox, Ring } from '../../components/charts';
import {
  type Column,
  Lab,
  LoadError,
  SkeletonBlock,
  SkeletonTable,
  SkeletonTiles,
  Table,
} from '../../components/ui';
import { api, apiPost } from '../../lib/api';
import { BATCH, QUEUE, RUN, STAGES, type StatusMap, statusText } from '../../lib/constants';
import { dialog, hideTip, showTip, toast } from '../../lib/feedback';
import { fmtAgo, fmtInt, fmtMs, fmtSpan, fmtTime } from '../../lib/format';
import { useApp } from '../../state/app';
import type { PipelineRun } from '../../types/api';

import type {
  BatchRow,
  HealthPayload,
  MappingTask,
  RecoverResult,
  RunRecovery,
  RunRow,
} from './types';

const CIRCUIT: StatusMap = {
  CLOSED: ['good', 'Closed'],
  OPEN: ['critical', 'Open'],
  HALF_OPEN: ['warning', 'Half open'],
};

function BatchBars({ W, batches }: { W: number; batches: BatchRow[] }) {
  const H = 120;
  const m = { l: 4, r: 4, t: 10, b: 22 };
  const rows = [...batches].reverse();
  const n = rows.length;
  const step = (W - m.l - m.r) / Math.max(n, 1);
  const bw = Math.max(3, Math.min(26, step * 0.66));
  const max = Math.max(...rows.map((b) => b.listedTotal || b.collected || 0), 1);
  const tip = (b: BatchRow, e: PointerEvent<SVGRectElement>) =>
    showTip(
      <>
        <TipHead>{fmtTime(b.slotTime)}</TipHead>
        <TipRow k="Status" v={statusText(BATCH, b.status)} />
        <TipRow k="Collected" v={`${fmtInt(b.collected)} of ${fmtInt(b.listedTotal)}`} />
        {b.scan?.counts ? <TipRow k="Queue" v={fmtInt(b.scan.counts.queue)} /> : null}
      </>,
      e.clientX,
      e.clientY,
    );
  const first = rows[0];
  const last = rows[n - 1];
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="chart batch-bars"
      role="img"
      aria-label={`${n} hourly batches.`}
    >
      {rows.map((b, i) => {
        const x = m.l + i * step + (step - bw) / 2;
        const full = ((b.listedTotal || 0) / max) * (H - m.t - m.b);
        const got = ((b.collected || 0) / max) * (H - m.t - m.b);
        return (
          <g key={b.id || b.slotTime || i}>
            <rect
              className="bb-track"
              x={x}
              y={H - m.b - full}
              width={bw}
              height={Math.max(1, full)}
              rx={3}
            />
            <rect
              className={`bb-fill ${(b.status || '').toLowerCase()}`}
              x={x}
              y={H - m.b - got}
              width={bw}
              height={Math.max(1, got)}
              rx={3}
            />
            <rect
              className="hit"
              x={m.l + i * step}
              y={0}
              width={step}
              height={H - m.b}
              onPointerEnter={(e) => tip(b, e)}
              onPointerMove={(e) => tip(b, e)}
              onPointerLeave={hideTip}
            />
          </g>
        );
      })}
      {first ? (
        <text className="tick" x={m.l} y={H - 6}>
          {fmtTime(first.slotTime)}
        </text>
      ) : null}
      {n > 1 && last ? (
        <text className="tick" x={W - m.r} y={H - 6} textAnchor="end">
          {fmtTime(last.slotTime)}
        </text>
      ) : null}
    </svg>
  );
}

/** "Latest run, stage by stage": the panel header hint and the bars. */
function Gantt({ run }: { run: PipelineRun | null | undefined }) {
  const stages = (run?.stages ?? []).filter(
    (s): s is typeof s & { startedAt: string } => !!s.startedAt,
  );
  if (!run || !stages.length)
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Latest run, stage by stage</h2>
          <span className="hint" />
        </div>
        <div className="empty">No run yet.</div>
      </div>
    );
  const now = Date.now();
  const t0 = Math.min(...stages.map((s) => new Date(s.startedAt).getTime()));
  const t1 = Math.max(
    ...stages.map((s) => (s.finishedAt ? new Date(s.finishedAt).getTime() : now)),
  );
  const span = Math.max(1, t1 - t0);
  const order = STAGES.map(([s]) => s);
  const sorted = [...stages].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Latest run, stage by stage</h2>
        <span className="hint">{`slot ${fmtTime(run.slotTime)}, ${fmtSpan(span / 1000)} in total`}</span>
      </div>
      <div>
        <div className="gantt">
          {sorted.map((s) => {
            const a = new Date(s.startedAt).getTime(),
              b = s.finishedAt ? new Date(s.finishedAt).getTime() : now;
            return (
              <div key={s.stage} className="gantt-row" title={s.error || ''}>
                <span className="gantt-name">
                  {STAGES.find(([k]) => k === s.stage)?.[1] ?? s.stage}
                </span>
                <span className="gantt-track">
                  <i
                    className={s.status}
                    style={{
                      left: `${((a - t0) / span) * 100}%`,
                      width: `${Math.max(0.6, ((b - a) / span) * 100)}%`,
                    }}
                  />
                </span>
                <span className="gantt-dur">{s.finishedAt ? fmtMs(b - a) : 'running'}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HealthTiles({ health }: { health: HealthPayload }) {
  const cov = health.coverage;
  const h = cov.sourceHealth;
  const budget = cov.monthlyRequestBudget || 0;
  const used = h?.budgetUsed || 0;
  return (
    <>
      <div className="tile">
        <span className="tile-label">Source</span>
        <b>{cov.provider ? cov.provider.name : '—'}</b>
        <span className="muted small">{cov.isLiveData ? 'live data' : 'synthetic'}</span>
      </div>
      <div className="tile">
        <span className="tile-label">Circuit</span>
        <b>
          <Lab map={CIRCUIT} k={String(h?.state || '').toUpperCase()} />
        </b>
        <span className="muted small">
          {h?.lastSuccessAt ? `last success ${fmtAgo(h.lastSuccessAt)}` : ''}
        </span>
      </div>
      <div className="tile with-ring">
        <Ring
          size={64}
          fraction={budget ? used / budget : 0}
          tone={used / (budget || 1) > 0.85 ? 'rose' : 'base'}
        />
        <div>
          <span className="tile-label">Requests this month</span>
          <b>{fmtInt(used)}</b>
          <span className="muted small">
            {budget ? `of ${fmtInt(budget)} local budget` : 'no budget'}
          </span>
        </div>
      </div>
      <div className="tile">
        <span className="tile-label">Known CMC coins</span>
        <b>{fmtInt(cov.knownAssets)}</b>
        <span className="muted small">
          {cov.lastDiscovery
            ? `discovered ${fmtAgo(cov.lastDiscovery.finishedAt || cov.lastDiscovery.startedAt)}`
            : ''}
        </span>
      </div>
    </>
  );
}

const BATCH_COLS: Column<BatchRow>[] = [
  { label: 'Slot', render: (b) => fmtTime(b.slotTime) },
  { label: 'Batch', render: (b) => <Lab map={BATCH} k={b.status} /> },
  {
    label: 'Collected',
    num: true,
    render: (b) => `${fmtInt(b.collected)} / ${fmtInt(b.listedTotal)}`,
  },
  {
    label: 'Ranks 1–1200',
    render: (b) =>
      b.missingRanks.length || b.duplicateRanks.length
        ? `${b.missingRanks.length} missing, ${b.duplicateRanks.length} duplicate`
        : 'contiguous',
  },
  { label: 'Scan', render: (b) => (b.scan ? <Lab map={RUN} k={b.scan.status} /> : '—') },
  {
    label: 'Queue',
    render: (b) =>
      b.scan?.queueStatus
        ? `${statusText(QUEUE, b.scan.queueStatus)}, ${fmtInt(b.scan.counts?.queue)}`
        : '—',
  },
  {
    label: 'Eligible / review / excluded',
    render: (b) =>
      b.scan?.counts
        ? `${fmtInt(b.scan.counts.eligible)} / ${fmtInt(b.scan.counts.needsReview)} / ${fmtInt(b.scan.counts.excluded)}`
        : '—',
  },
  { label: 'Export', render: (b) => (b.scan ? b.scan.exportStatus || '—' : '—') },
  {
    label: 'Notes',
    render: (b) => (
      <span className="small">
        {[...(b.statusReasons || []), ...(b.scan?.warnings ?? []).map((w) => w.split(':')[0])].join(
          ', ',
        )}
      </span>
    ),
  },
];

const RECOVER_ACTION: Record<RunRecovery['action'], string> = {
  crawl_current: 'crawled again',
  reprocess_batch: 'stored crawl reprocessed',
  catch_up_current: 'caught up with the current hour',
  catch_up_daily: 'daily history refilled, latest batch recomputed',
};
const RECOVERABLE = ['failed', 'missed'];

function RecoveryNote({ rec }: { rec: RunRecovery }) {
  const what = RECOVER_ACTION[rec.action] ?? rec.action;
  const text =
    rec.status === 'running'
      ? `Recovering: ${what}…`
      : rec.status === 'failed'
        ? `Recovery failed (${what}): ${rec.error ?? 'unknown error'}`
        : `Recovered: ${what}${rec.summary ? `. ${rec.summary}` : ''}`;
  return (
    <span
      className={`small ${rec.status === 'failed' ? 'error' : 'muted'}`}
      title={`by ${rec.requestedBy}, ${fmtTime(rec.requestedAt)}`}
    >
      {text}
    </span>
  );
}

const RUN_COLS: Column<RunRow>[] = [
  { label: 'Slot', render: (r) => fmtTime(r.slotTime) },
  { label: 'Kind', render: (r) => r.kind },
  { label: 'Status', render: (r) => <Lab map={RUN} k={r.status} /> },
  {
    label: 'Stages',
    render: (r) => (
      <span className="stage-dots">
        {STAGES.map(([s, label]) => {
          const st = (r.stages || []).find((x) => x.stage === s);
          return (
            <i
              key={s}
              className={st ? st.status : 'none'}
              title={`${label}: ${st ? st.status : 'not run'}`}
            />
          );
        })}
      </span>
    ),
  },
  { label: 'Error', render: (r) => <span className="small error">{r.error || ''}</span> },
];

/** Owner-only "Recover" on a failed or missed hour; explains first what can and cannot come back. */
function recoverRun(r: RunRow, onStarted: () => void) {
  void dialog({
    title: `Recover the ${fmtTime(r.slotTime)} run?`,
    body: (
      <>
        <p>What runs depends on what this hour left behind:</p>
        <ul className="small">
          <li>The current hour: crawled again now.</li>
          <li>A past hour whose crawl was stored: scan and export recomputed from that crawl.</li>
          <li>
            A past hour with nothing stored: the source only gives current prices, so that
            hour&apos;s snapshot cannot be fetched again and stays a gap. Instead, everything still
            available is fetched: the current hour if it has not run, otherwise daily history (which
            covers the whole 30-day window) and a fresh scan of the latest batch.
          </li>
        </ul>
        <p className="muted small">
          No Telegram report is sent and no forward-test event is created for a past hour.
        </p>
      </>
    ),
    ok: 'Recover',
    onSubmit: async () => {
      const res = await apiPost<RecoverResult>(`pipeline/runs/${r.id}/recover`, {});
      if (!res.ok) throw new Error(res.reason || 'recovery did not start');
      toast(
        `Recovery started: ${res.action ? RECOVER_ACTION[res.action] : 'running'}. This table updates when it finishes.`,
      );
    },
  }).then((started) => {
    if (started) onStarted();
  });
}

interface HealthData {
  batches: BatchRow[];
  health: HealthPayload;
  tasks: MappingTask[];
}

export default function Batches() {
  const { overview, openCoin, dataVersion, can } = useApp();
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [batches, health, tasks] = await Promise.all([
        api<BatchRow[]>('batches'),
        api<HealthPayload>('health'),
        api<MappingTask[]>('mapping-tasks?status=OPEN'),
      ]);
      setData({ batches, health, tasks });
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [dataVersion, load]);

  // Follow a recovery running in the background until its note settles.
  const recovering = !!data?.health.runs.some((r) => r.metrics?.recovery?.status === 'running');
  useEffect(() => {
    if (!recovering) return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [recovering, load]);

  const runCols: Column<RunRow>[] = [
    ...RUN_COLS,
    {
      label: 'Recovery',
      render: (r) => {
        const rec = r.metrics?.recovery;
        const canRecover =
          can('pipeline:recover') &&
          RECOVERABLE.includes(r.status) &&
          rec?.status !== 'running' &&
          r.kind === 'hourly';
        return (
          <span className="recover-cell">
            {rec ? <RecoveryNote rec={rec} /> : null}
            {canRecover ? (
              <button
                type="button"
                className="btn small"
                title="Fetch again what this hour missed, where the source still has it"
                onClick={() => recoverRun(r, () => void load())}
              >
                {rec ? 'Recover again' : 'Recover'}
              </button>
            ) : null}
          </span>
        );
      },
    },
  ];

  const taskCols: Column<MappingTask>[] = [
    {
      label: 'Coin',
      render: (x) => (
        <button type="button" className="linkish" onClick={() => openCoin(x.cmcId)}>
          {`CMC ${x.cmcId}`}
        </button>
      ),
    },
    { label: 'LBank pair', render: (x) => x.marketPair },
    { label: 'Kind', render: (x) => x.kind },
    {
      label: 'Evidence',
      render: (x) => <span className="small">{JSON.stringify(x.evidence)}</span>,
    },
    { label: 'Since', render: (x) => fmtTime(x.createdAt) },
  ];

  return (
    <>
      <div className="tiles">{data ? <HealthTiles health={data.health} /> : <SkeletonTiles />}</div>
      <Gantt run={overview?.latestRun} />
      <div className="panel">
        <div className="panel-head">
          <h2>Hourly crawl batches</h2>
          <span className="hint">one per UTC hour; a missing hour stays a visible gap</span>
        </div>
        <div>
          {data && data.batches.length ? (
            <ChartBox>{(W) => <BatchBars W={W} batches={data.batches} />}</ChartBox>
          ) : !data && !error ? (
            <SkeletonBlock height={160} />
          ) : (
            <div className="chart-box" />
          )}
        </div>
        <div className="table-wrap">
          {error ? (
            <LoadError error={error} />
          ) : data ? (
            <Table
              cols={BATCH_COLS}
              rows={data.batches}
              empty="No crawl batches yet."
              rowKey={(b, i) => b.id || i}
            />
          ) : (
            <SkeletonTable rows={8} />
          )}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Pipeline runs</h2>
        </div>
        <div className="table-wrap">
          {data ? (
            <Table
              cols={runCols}
              rows={data.health.runs}
              empty="No runs yet."
              rowKey={(r, i) => r.id || i}
            />
          ) : (
            <SkeletonTable rows={6} />
          )}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Open LBank mapping tasks</h2>
          <span className="hint">ambiguous tickers waiting for you</span>
        </div>
        <div className="table-wrap">
          {data ? (
            <Table
              cols={taskCols}
              rows={data.tasks}
              empty="No open mapping tasks."
              rowKey={(t, i) => t.id || i}
            />
          ) : (
            <SkeletonTable rows={3} />
          )}
        </div>
      </div>
    </>
  );
}

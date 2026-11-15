// The run pulse: progress / countdown ring, the latest run's stages, and "Reprocess latest batch".
import { type ReactNode, useState } from 'react';

import { Ring } from '../../components/charts';
import { Lab } from '../../components/ui';
import { apiPost, errorMessage } from '../../lib/api';
import { RUN, STAGES, statusText } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { countdownText, fmtAgo, fmtClock, fmtInt, fmtMs, fmtSpan, fmtTime } from '../../lib/format';
import { useApp, useNow } from '../../state/app';
import type { AppConfig, OperateResult, Overview, PipelineRun } from '../../types/api';

/** Share of the interval to the next run that has passed (for the countdown ring). */
function hourFraction(cfg: AppConfig, nextIso: string, now: number): number {
  const interval = (cfg.strategy.crawlIntervalMinutes || 60) * 60_000;
  const left = new Date(nextIso).getTime() - now;
  return 1 - Math.max(0, Math.min(1, left / interval));
}

export default function Pulse() {
  const { overview: ov, cfg } = useApp();
  if (!ov)
    return (
      <div className="panel pulse" aria-live="polite">
        Loading…
      </div>
    );
  return (
    <div className="panel pulse" aria-live="polite">
      <PulseRing ov={ov} cfg={cfg} />
      {ov.latestRun ? (
        <PulseBody run={ov.latestRun} />
      ) : (
        <div className="pulse-body">
          <h2>Waiting for the first run</h2>
          <p className="muted">
            {cfg.schedulerEnabled
              ? 'The scheduler starts one at the next slot.'
              : 'Start one with npm run cli -- run-once.'}
          </p>
        </div>
      )}
    </div>
  );
}

function PulseRing({ ov, cfg }: { ov: Overview; cfg: AppConfig }) {
  const now = useNow(1000);
  const run = ov.latestRun;
  const sch = ov.schedule;
  const p = run && run.status === 'running' ? run.progress : null;
  let ring: ReactNode, center: ReactNode;
  if (run && p) {
    ring = <Ring size={148} fraction={p.percent / 100} tone="violet" />;
    center = (
      <div className="ring-center">
        <b>{p.percent}%</b>
        <span>{run.currentStageLabel || run.currentStage || 'starting'}</span>
      </div>
    );
  } else if (sch?.enabled && sch.nextRunAt) {
    ring = <Ring size={148} fraction={hourFraction(cfg, sch.nextRunAt, now)} tone="base" />;
    center = (
      <div className="ring-center">
        <b>{countdownText(sch.nextRunAt, now)}</b>
        <span>next run {fmtClock(sch.nextRunAt)}</span>
      </div>
    );
  } else {
    ring = <Ring size={148} fraction={0} tone="" />;
    center = (
      <div className="ring-center">
        <b>Off</b>
        <span>automatic runs</span>
      </div>
    );
  }
  return (
    <div className="ring-box">
      {ring}
      {center}
    </div>
  );
}

const elapsedSeconds = (from: string, to: string | number): number =>
  (new Date(to).getTime() - new Date(from).getTime()) / 1000;

function PulseBody({ run }: { run: PipelineRun }) {
  const { can } = useApp();
  const now = useNow(1000);
  const running = run.status === 'running';
  const p = running ? run.progress : null;
  const stages = run.stages || [];
  const done = new Set(stages.filter((s) => s.status === 'succeeded').map((s) => s.stage));
  const failed = new Set(stages.filter((s) => s.status === 'failed').map((s) => s.stage));
  const metrics: Record<string, unknown> = run.metrics ?? {};
  const stageMs = (s: string): number | null => {
    const v = metrics[`${s}Ms`];
    return typeof v === 'number' ? v : null;
  };
  const degraded = Array.isArray(metrics.degraded) ? metrics.degraded : [];
  const item = p?.current ?? null;
  const elapsed = run.startedAt ? elapsedSeconds(run.startedAt, now) : null;
  const headline = running
    ? `${run.currentStageLabel || run.currentStage || 'Starting'}`
    : run.status === 'succeeded'
      ? 'Last run finished cleanly'
      : run.status === 'partial'
        ? 'Last run finished with gaps'
        : `Last run ${statusText(RUN, run.status).toLowerCase()}`;
  return (
    <div className="pulse-body">
      <div className="pulse-status">
        <Lab map={RUN} k={run.status} />
        <span className="muted">slot {fmtTime(run.slotTime)}</span>
      </div>
      <h2>{headline}</h2>
      <p className="muted small">
        {running
          ? `Step ${Math.min(p ? p.stagesDone + 1 : 1, p ? p.stagesTotal : 8)} of ${p ? p.stagesTotal : 8}${elapsed !== null ? `, ${fmtSpan(elapsed)} so far` : ''}`
          : `Finished ${fmtAgo(run.finishedAt)}${run.startedAt && run.finishedAt ? ` after ${fmtSpan(elapsedSeconds(run.startedAt, run.finishedAt))}` : ''}`}
      </p>
      {item ? (
        <div className="item-progress">
          <div className="small">
            {`${fmtInt(item.done)} of ${fmtInt(item.total)} ${item.unit}${item.etaSeconds !== null && item.etaSeconds !== undefined ? `, about ${fmtSpan(item.etaSeconds)} left` : ''}`}
          </div>
          <progress
            className="bar"
            max={item.total}
            value={item.done}
            aria-label={`${run.currentStage}: ${item.done} of ${item.total} ${item.unit}`}
          />
        </div>
      ) : null}
      <ol className="steps" aria-label="Pipeline stages">
        {STAGES.map(([s, label]) => {
          const ms = stageMs(s);
          return (
            <li
              key={s}
              className={`${done.has(s) ? 'done' : ''}${failed.has(s) ? ' failed' : ''}${run.currentStage === s ? ' active' : ''}`}
              title={ms ? `${label}: ${fmtMs(ms)}` : label}
            >
              <span className="step-dot" aria-hidden="true" />
              <span className="step-name">{label}</span>
            </li>
          );
        })}
      </ol>
      {degraded.length ? (
        <ul className="notes small">
          {degraded.map((d, i) => (
            <li key={i}>{String(d)}</li>
          ))}
        </ul>
      ) : null}
      {run.error ? <div className="error small">{run.error}</div> : null}
      {can('scan:operate') ? (
        <div className="row-actions">
          <RescanButton />
        </div>
      ) : null}
    </div>
  );
}

function RescanButton() {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const rescan = async () => {
    setBusy(true);
    try {
      const r = await apiPost<OperateResult>('scan/rescan', {});
      if (r.ok)
        toast(`Reprocessed. The queue now has ${r.counts ? fmtInt(r.counts.queue) : '?'} coins.`);
      else toast(`Not reprocessed: ${r.reason}`, 'warning');
      await refresh(true);
    } catch (err) {
      toast(`Reprocess failed: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="btn"
      disabled={busy}
      title="Recompute the latest stored batch from saved data (no crawling) and export it again"
      onClick={rescan}
    >
      {busy ? 'Reprocessing…' : 'Reprocess latest batch'}
    </button>
  );
}

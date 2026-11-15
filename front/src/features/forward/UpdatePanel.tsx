// Progress of a daily High check (started by "Update Highs now" or found running), then what it
// found: events checked, new highest Highs, unchanged, data unavailable, errors. Polls
// GET /api/forward/update-runs/:id while the run is running; the result stays until dismissed.
import { useEffect, useRef, useState } from 'react';

import { Lab } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { RUN } from '../../lib/constants';
import { fmtInt, fmtSpan, fmtTime } from '../../lib/format';

import type { UpdateRun } from './types';

const POLL_MS = 1500;

const PHASE: Record<string, string> = {
  starting: 'Starting…',
  fetching: 'Requesting missing CMC daily rows (at most 10 minutes)…',
  evaluating: 'Checking events',
  done: 'Finishing…',
};

export function checksLine(run: UpdateRun): string {
  const c = run.checks;
  if (!c) return run.notes.at(-1) ?? '';
  return [
    `${fmtInt(c.checked)} events checked`,
    `${fmtInt(c.newRecord)} new highest High`,
    `${fmtInt(c.unchanged)} unchanged`,
    `${fmtInt(c.dataUnavailable)} data unavailable`,
    `${fmtInt(c.errors)} ${c.errors === 1 ? 'error' : 'errors'}`,
  ].join(' · ');
}

export default function UpdatePanel({
  runId,
  onFinished,
  onDismiss,
}: {
  runId: string;
  onFinished: () => void;
  onDismiss: () => void;
}) {
  const [run, setRun] = useState<UpdateRun | null>(null);
  const [error, setError] = useState('');
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await api<UpdateRun>(`forward/update-runs/${runId}`);
        if (stop) return;
        setRun(r);
        setError('');
        if (r.status === 'running') timer = setTimeout(() => void poll(), POLL_MS);
        else finished.current();
      } catch (e) {
        if (stop) return;
        setError(errorMessage(e));
        timer = setTimeout(() => void poll(), POLL_MS * 2);
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [runId]);

  const running = !run || run.status === 'running';
  const p = run?.progress;
  const took =
    run?.finishedAt && run.startedAt
      ? (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
      : null;
  return (
    <div className="panel fwd-update" role="status" aria-live="polite">
      <div className="panel-head">
        <h2>{running ? 'Checking Highs now' : 'High check finished'}</h2>
        {run ? <Lab map={RUN} k={run.status} /> : null}
        {!running ? (
          <button type="button" className="btn small" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
      <div className="item-progress">
        {running ? (
          <>
            <span>
              {p ? PHASE[p.phase] || p.phase : 'Starting…'}
              {p && p.phase === 'evaluating'
                ? ` · ${fmtInt(p.processed)} of ${fmtInt(p.total)}`
                : ''}
            </span>
            <progress
              className="bar"
              max={p && p.total ? p.total : 1}
              value={p && p.phase === 'evaluating' ? p.processed : undefined}
            />
            <span className="muted small">
              {run ? `Started ${fmtTime(run.startedAt)} (${run.trigger}).` : ''} The table updates
              when it finishes.
            </span>
          </>
        ) : (
          <>
            <b>{checksLine(run)}</b>
            {run.checks?.notDue ? (
              <span className="muted small">
                {`${fmtInt(run.checks.notDue)} more events were not due: their identification day (UTC) has not ended yet.`}
              </span>
            ) : null}
            <span className="muted small">
              {`Finished ${fmtTime(run.finishedAt)}${took !== null ? ` in ${fmtSpan(took)}` : ''}; data checked through ${run.updateDate} (UTC), the last closed UTC day. A check that finds no new High still counts as checked.`}
            </span>
            {run.status === 'failed' && run.error ? (
              <span className="form-error">{run.error}</span>
            ) : run.status === 'partial' && run.notes[0] ? (
              <span className="muted small">{run.notes[0]}</span>
            ) : null}
          </>
        )}
        {error ? <span className="form-error">{error}</span> : null}
      </div>
    </div>
  );
}

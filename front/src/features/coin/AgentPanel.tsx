// The Agent tab: Claude's own view of the coin, run on request (owners, agent:use; limited per
// window, one run at a time; the server enforces both). Agent output is untrusted text and is
// rendered as React text only. It never changes stored data or Tier 1 results.
import { useCallback, useEffect, useRef, useState } from 'react';

import { Chip, type Column, Kv, Table } from '../../components/ui';
import { api, apiPost, errorMessage } from '../../lib/api';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtClock, fmtInt, fmtMs, fmtTime, isNum, num, shortId } from '../../lib/format';

import type { AgentAnalysis, AgentFactor, AgentStatus } from './types';

const OUTLOOK: Record<string, readonly [string, string]> = {
  PUMP_LIKELY: ['Pump likely', 'likely'],
  PUMP_POSSIBLE: ['Pump possible', 'possible'],
  PUMP_UNLIKELY: ['Pump unlikely', 'unlikely'],
  INSUFFICIENT_DATA: ['Not enough data', 'nodata'],
};
const OutlookBadge = ({ o }: { o: string | null }) => (
  <span className={`outlook ${(o && OUTLOOK[o]?.[1]) || 'nodata'}`}>
    {(o && OUTLOOK[o]?.[0]) || o || '—'}
  </span>
);
const lower = (s: string | null | undefined) =>
  String(s || '')
    .replace(/_/g, ' ')
    .toLowerCase();

/**
 * Loads the agent state for one coin and polls while a run is in progress (3 s for this coin,
 * 10 s while another coin's run blocks this one). The analysis picked from the history stays
 * shown until a new run finishes.
 */
export default function AgentPanel({ cmcId }: { cmcId: number }) {
  const [st, setSt] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const gen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const runningHere = useRef(false);

  const load = useCallback(
    async (g: number) => {
      if (g !== gen.current) return;
      clearTimeout(timer.current);
      let s: AgentStatus;
      try {
        s = await api<AgentStatus>(`assets/${cmcId}/agent`);
      } catch (e) {
        if (g === gen.current) setError(e);
        return;
      }
      // Still the same coin and still mounted.
      if (g !== gen.current) return;
      const here = !!(s.running && s.running.cmcId === cmcId);
      if (runningHere.current && !here) {
        const done = s.analyses[0];
        if (done && done.status === 'SUCCEEDED') toast(`Claude's view on ${done.symbol} is ready.`);
        else if (done && done.status === 'FAILED')
          toast(`Claude's analysis of ${done.symbol} failed: ${done.errorMessage}`, 'error');
        setSelected(undefined);
      }
      runningHere.current = here;
      setError(null);
      setSt(s);
      if (s.running) timer.current = setTimeout(() => void load(g), here ? 3000 : 10000);
    },
    [cmcId],
  );

  useEffect(() => {
    const g = ++gen.current;
    runningHere.current = false;
    setSt(null);
    setError(null);
    setSelected(undefined);
    void load(g);
    return () => {
      gen.current++;
      clearTimeout(timer.current);
    };
  }, [load]);

  const reloadNow = () => {
    setSelected(undefined);
    void load(gen.current);
  };

  if (error)
    return (
      <section className="panel agent-panel">
        <div className="error">{`Could not load the agent: ${errorMessage(error)}`}</div>
      </section>
    );
  if (!st)
    return (
      <section className="panel agent-panel">
        <div className="skeleton short">
          <i />
        </div>
      </section>
    );

  const q = st.quota;
  const shown =
    st.analyses.find((a) => a.id === selected) ||
    st.analyses.find((a) => a.status === 'RUNNING') ||
    st.analyses[0] ||
    null;
  return (
    <section className="panel agent-panel">
      <div className="panel-head">
        <h3>Claude&apos;s view</h3>
        <span className="hint">{`${st.model}, ${q.remaining} of ${q.max} runs left in ${q.windowHours} h`}</span>
      </div>
      <p className="muted small">
        {`Claude reads this coin's stored data (the Tier 1 trace, hourly prices, BTC and ETH, the forward test) and gives its own view on a pump within ${st.horizonHours / 24} days. It is an AI opinion for your own chart review, not a trading signal, and it can be wrong.`}
      </p>
      <AgentAction cmcId={cmcId} st={st} onStarted={reloadNow} />
      {shown ? (
        <AnalysisView a={shown} st={st} />
      ) : (
        <div className="empty">No analysis of this coin yet.</div>
      )}
      {st.analyses.length > 1 ? (
        <AgentHistory st={st} shown={shown} onPick={(a) => setSelected(a.id)} />
      ) : null}
    </section>
  );
}

function AgentAction({
  cmcId,
  st,
  onStarted,
}: {
  cmcId: number;
  st: AgentStatus;
  onStarted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const q = st.quota;
  if (!st.available)
    return (
      <div className="agent-action">
        <p className="error small">{st.reason || 'The agent is not available.'}</p>
      </div>
    );
  if (st.running)
    return (
      <div className="agent-action">
        {st.running.cmcId === cmcId ? (
          <p className="agent-busy">
            <span className="spinner" aria-hidden="true" />
            {`Claude is analysing ${st.running.symbol} (started ${fmtAgo(st.running.requestedAt)} by ${st.running.requestedBy}). This usually takes one to three minutes.`}
          </p>
        ) : (
          <p className="muted small">
            {`Claude is analysing ${st.running.symbol} for ${st.running.requestedBy}; one run at a time. You can start this one when it finishes.`}
          </p>
        )}
      </div>
    );
  if (q.remaining <= 0)
    return (
      <div className="agent-action">
        <button type="button" className="btn primary" disabled>
          Ask Claude
        </button>
        <span className="muted small">
          {`Limit reached: ${q.used} of ${q.max} runs in the last ${q.windowHours} h. The next run is possible at ${fmtTime(q.nextFreeAt)}.`}
        </span>
      </div>
    );
  const run = async () => {
    setBusy(true);
    try {
      await apiPost(`assets/${cmcId}/agent`, {});
      toast("Claude is reading the coin's data. The view appears here when it is ready.");
    } catch (err) {
      toast(`Analysis not started: ${errorMessage(err)}`, 'error');
    }
    setBusy(false);
    setConfirming(false);
    onStarted();
  };
  return (
    <div className="agent-action">
      {confirming ? (
        <>
          <span className="small">{`Use 1 of the ${q.remaining} runs left? The limit is ${q.max} per ${q.windowHours} h.`}</span>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>
            Run analysis
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn primary" onClick={() => setConfirming(true)}>
            Ask Claude
          </button>
          <span className="muted small">{`${q.remaining} of ${q.max} runs left in ${q.windowHours} h, shared by all owners.`}</span>
        </>
      )}
    </div>
  );
}

function AgentList({
  title,
  items,
  kind,
}: {
  title: string;
  items: readonly (string | AgentFactor)[] | null | undefined;
  kind?: string;
}) {
  return (
    <div className={`agent-list${kind ? ` ${kind}` : ''}`}>
      <h4>{title}</h4>
      {items && items.length ? (
        <ul>
          {items.map((x, i) =>
            typeof x === 'string' ? (
              <li key={i}>{x}</li>
            ) : (
              <li key={i}>
                <span>{x.point}</span>
                <small className="mono">{x.evidence}</small>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="muted small">None.</p>
      )}
    </div>
  );
}

function AnalysisView({ a, st }: { a: AgentAnalysis; st: AgentStatus }) {
  const when = `${fmtTime(a.requestedAt)} by ${a.requestedBy}`;
  if (a.status === 'RUNNING')
    return (
      <div className="agent-card running">
        <span className="spinner" aria-hidden="true" />
        <span>{`Running since ${fmtClock(a.requestedAt)} (${when}).`}</span>
      </div>
    );
  const o = a.output;
  if (a.status === 'FAILED' || !o)
    return (
      <div className="agent-card failed">
        <div className="agent-verdict">
          <Chip dot="critical">Failed</Chip>
          <span className="muted small">{when}</span>
        </div>
        <p>{a.errorMessage || 'The run failed.'}</p>
        <p className="muted small">
          {a.countsTowardLimit
            ? 'This run counts toward the limit (Claude had already answered).'
            : 'This run did not count toward the limit.'}
        </p>
        <RunDetails a={a} />
      </div>
    );
  return (
    <article className="agent-card">
      <div className="agent-verdict">
        <OutlookBadge o={a.outlook} />
        <Chip
          tone={a.confidence === 'HIGH' ? 'violet' : undefined}
        >{`${lower(a.confidence)} confidence`}</Chip>
        <span className="muted small">{`next ${st.horizonHours / 24} days, ${when}`}</span>
      </div>
      <p className="agent-headline">{o.headline}</p>
      {a.isLive ? null : <p className="error small">Synthetic fixture data, not market data.</p>}
      <div className="agent-mindset">
        {o.mindset
          .split(/\n\s*\n/)
          .filter((p) => p.trim())
          .map((p, i) => (
            <p key={i}>{p}</p>
          ))}
      </div>
      <div className="grid-2 tight">
        <AgentList title="For a pump" items={o.bullishFactors} kind="pro" />
        <AgentList title="Against" items={o.bearishFactors} kind="con" />
      </div>
      <div className="agent-list">
        <h4>Strategy fit</h4>
        <p>{o.strategyFit}</p>
      </div>
      <div className="grid-2 tight">
        <AgentList title="Risks" items={o.risks} />
        <AgentList title="Data gaps" items={o.dataGaps} />
      </div>
      <AgentList title="Watch next" items={o.watchNext} />
      <div className="chips">
        <span className="muted small">Claude&apos;s read for Tier 2:</span>
        <Chip tone="violet">{`candle ${lower(o.candleState)}`}</Chip>
        <Chip tone="violet">{`BTC/ETH ${lower(o.marketRegime)}`}</Chip>
      </div>
      {a.guardrailNotes.length ? (
        <ul className="notes warnings small">
          {a.guardrailNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      <RunDetails a={a} />
    </article>
  );
}

function RunDetails({ a }: { a: AgentAnalysis }) {
  const u = a.usage;
  const calls = (a.toolCalls || []).map((c) => (c.denied ? `${c.name} (refused)` : c.name));
  const cost = num(u?.costUsd ?? null);
  return (
    <details className="fold agent-meta">
      <summary>Run details</summary>
      <Kv
        pairs={[
          ['Requested', `${fmtTime(a.requestedAt)} by ${a.requestedBy}`],
          [
            'Finished',
            a.finishedAt ? `${fmtTime(a.finishedAt)}, after ${fmtMs(u?.durationMs) || '—'}` : '—',
          ],
          [
            'Model',
            `${u?.models?.length ? u.models.join(', ') : a.model}${u?.refusalFallback ? ' (fallback used)' : ''}`,
          ],
          ['Effort and turns', `${a.effort}, ${u?.numTurns ?? '—'} turns`],
          [
            'Tokens',
            `${fmtInt(u?.inputTokens)} in, ${fmtInt(u?.outputTokens)} out, ${fmtInt(u?.cacheReadTokens)} from cache`,
          ],
          [
            'Estimated cost',
            isNum(cost)
              ? `$${cost.toFixed(2)} at list prices (a subscription is not billed per run)`
              : '—',
          ],
          ['Data', `batch ${shortId(a.batchId)}, ruleset ${a.rulesetVersion}`],
          ['Instructions', a.promptVersion],
          ['Tools used', calls.join(', ') || 'none'],
        ]}
      />
    </details>
  );
}

function AgentHistory({
  st,
  shown,
  onPick,
}: {
  st: AgentStatus;
  shown: AgentAnalysis | null;
  onPick: (a: AgentAnalysis) => void;
}) {
  const cols: Column<AgentAnalysis>[] = [
    { label: 'When', render: (a) => fmtTime(a.requestedAt) },
    {
      label: 'View',
      render: (a) =>
        a.status === 'SUCCEEDED' ? (
          <OutlookBadge o={a.outlook} />
        ) : (
          <Chip dot={a.status === 'FAILED' ? 'critical' : 'warning'}>{lower(a.status)}</Chip>
        ),
    },
    { label: 'Confidence', render: (a) => (a.confidence ? lower(a.confidence) : '—') },
    { label: 'By', render: (a) => a.requestedBy },
    {
      label: '',
      render: (a) => (shown && a.id === shown.id ? <span className="muted small">shown</span> : ''),
    },
  ];
  return (
    <div className="agent-history">
      <h4>All analyses of this coin</h4>
      <div className="table-wrap">
        <Table cols={cols} rows={st.analyses} rowKey={(a) => a.id} onRow={onPick} />
      </div>
    </div>
  );
}

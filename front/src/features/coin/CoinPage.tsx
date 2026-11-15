// /coins/:cmcId?tab=review|agent|history|details&batch=<scan batch id>
// One coin's Tier 1 trace: summary, then Review / Agent / History / Calculation details tabs. The
// trace is refetched in place after a review or an LBank decision, so the page and the live chart
// iframe stay mounted.
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { ErrorBoundary } from '../../components/ErrorBoundary';
import { Logo } from '../../components/ui';
import { ApiError, api, apiPost, errorMessage } from '../../lib/api';
import { hideTip, toast } from '../../lib/feedback';
import { fmtInt } from '../../lib/format';
import { type CoinTab, pathOf } from '../../lib/routes';
import { useApp } from '../../state/app';

import AgentPanel from './AgentPanel';
import ReviewForm, { CHART_FIELDS } from './ReviewForm';
import './coin.css';
import {
  CoinHero,
  CurrentObservation,
  DailyRowsPanel,
  LbankDecisions,
  LbankPanel,
  MetadataChanges,
  ReviewHistory,
  WindowsPanel,
} from './detail/Sections';
import ChartPanel, { type ChartFields } from './panels/ChartPanel';
import PricePanel from './panels/PricePanel';
import VenuePanel from './panels/VenuePanel';
import VmcPanel from './panels/VmcPanel';
import type { AssetTrace } from './types';

const TAB_KEYS: readonly CoinTab[] = ['review', 'agent', 'history', 'details'];
const NOT_FOUND =
  'This coin has no Tier 1 record in the latest scan, so there is nothing to trace yet. Coins appear here after a run collects them.';

const traceUrl = (cmcId: number, batchId: string | null) =>
  `assets/${cmcId}/trace${batchId ? `?batchId=${encodeURIComponent(batchId)}` : ''}`;

type Load =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ok'; trace: AssetTrace }
  | { key: string; status: 'error'; error: unknown };

export default function CoinPage() {
  const { cmcId: raw } = useParams();
  const cmcId = /^\d+$/.test(raw ?? '') ? Number(raw) : NaN;
  const valid = Number.isSafeInteger(cmcId) && cmcId > 0;
  const [params] = useSearchParams();
  const batch = params.get('batch') || null;
  const key = `${cmcId}:${batch ?? ''}`;
  const [state, setState] = useState<Load>({ key, status: 'loading' });
  const { setPageHead } = useApp();

  useEffect(() => {
    if (!valid) return undefined;
    let stale = false;
    setState({ key, status: 'loading' });
    api<AssetTrace>(traceUrl(cmcId, batch))
      .then((trace) => {
        if (!stale) setState({ key, status: 'ok', trace });
      })
      .catch((error: unknown) => {
        if (!stale) setState({ key, status: 'error', error });
      });
    return () => {
      stale = true;
    };
  }, [key, cmcId, batch, valid]);

  /** Refetch the trace (after a review or an LBank decision) in place, without the skeleton. */
  const current = useRef(key);
  current.current = key;
  const reload = useCallback(
    async (batchId: string) => {
      const forKey = current.current;
      const trace = await api<AssetTrace>(traceUrl(cmcId, batchId));
      if (current.current === forKey) setState({ key: forKey, status: 'ok', trace });
      return trace;
    },
    [cmcId],
  );

  const ready = state.key === key ? state : { key, status: 'loading' as const };
  const t = ready.status === 'ok' ? ready.trace : null;

  // The shell's title and subtitle show the coin while this page is open.
  const title = !valid
    ? 'Coin not found'
    : t
      ? t.record.symbol
      : ready.status === 'error'
        ? `CMC id ${cmcId}`
        : 'Loading…';
  const sub = t
    ? `${t.record.name}${t.record.rank ? `, rank ${t.record.rank}` : ''}, CMC id ${t.record.cmcId}${t.batch.isLive ? '' : ', synthetic'}`
    : valid
      ? `CMC id ${cmcId}`
      : '';
  useEffect(() => {
    setPageHead({ title, sub });
  }, [setPageHead, title, sub]);
  useEffect(() => () => setPageHead(null), [setPageHead]);

  let body: ReactNode;
  if (!valid)
    body = (
      <div className="panel">
        <p>{NOT_FOUND}</p>
      </div>
    );
  else if (ready.status === 'loading')
    body = (
      <div className="skeleton">
        <i />
        <i />
        <i />
      </div>
    );
  else if (ready.status === 'error')
    body = (
      <div className="panel">
        <p>
          {ready.error instanceof ApiError && ready.error.status === 404
            ? NOT_FOUND
            : `Could not load the coin: ${errorMessage(ready.error)}`}
        </p>
      </div>
    );
  else body = <CoinDetail t={ready.trace} reload={reload} />;

  return (
    <div className="coin-page">
      <CoinTopBar cmcId={valid ? cmcId : null} />
      {body}
    </div>
  );
}

/** Back (to the list the coin was opened from, else the review queue) and the coin's logo. */
function CoinTopBar({ cmcId }: { cmcId: number | null }) {
  const navigate = useNavigate();
  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(pathOf('queue'));
  };
  return (
    <div className="coin-topbar">
      <button type="button" className="btn small coin-back" onClick={back}>
        <span aria-hidden="true">←</span> Back
      </button>
      {cmcId ? (
        <span className="coin-topbar-logo">
          <Logo key={cmcId} cmcId={cmcId} size={40} />
        </span>
      ) : null}
    </div>
  );
}

function CoinDetail({
  t,
  reload,
}: {
  t: AssetTrace;
  reload: (batchId: string) => Promise<unknown>;
}) {
  const { can, me } = useApp();
  const [params, setParams] = useSearchParams();
  const r = t.record;
  const lb = t.lbank;
  const changes = t.metadataChanges || [];
  const formRef = useRef<HTMLFormElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const canAgent = can('agent:use');

  const tabs: [CoinTab, string, number | null][] = [
    ['review', 'Review', null],
    // Owners only (the server checks agent:use on every call as well).
    ...(canAgent ? ([['agent', 'Agent', null]] as [CoinTab, string, null][]) : []),
    ['history', 'History', t.reviews.length + lb.decisions.length + changes.length],
    ['details', 'Calculation details', null],
  ];
  const asked = params.get('tab');
  const current: CoinTab =
    asked && (TAB_KEYS as readonly string[]).includes(asked) && tabs.some(([k]) => k === asked)
      ? (asked as CoinTab)
      : 'review';

  const show = (k: CoinTab, focus = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (k === 'review') next.delete('tab');
        else next.set('tab', k);
        return next;
      },
      { replace: true },
    );
    const bar = barRef.current;
    const b = bar?.querySelector<HTMLButtonElement>(`[data-k="${k}"]`);
    if (bar && b) {
      if (focus) b.focus();
      // Narrow screens scroll the tab strip sideways: keep the chosen tab in view.
      bar.scrollTo({ left: b.offsetLeft - 16, behavior: 'smooth' });
    }
    hideTip();
  };
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = tabs.findIndex(([k]) => k === current);
    show(tabs[(i + dir + tabs.length) % tabs.length]![0], true);
  };

  const decide = async (decision: string, marketPair: string | null) => {
    const note = formRef.current?.elements.namedItem('venueNote');
    try {
      await apiPost('venue-decisions', {
        cmcId: r.cmcId,
        batchId: r.batchId,
        marketPair: marketPair || null,
        decision,
        reviewer: me.username,
        note: (note instanceof HTMLInputElement && note.value) || undefined,
      });
      toast(
        `${decision.replace(/_/g, ' ').toLowerCase()} recorded for ${marketPair || 'the coin'}. It applies from the next scan, or now with “Reprocess latest batch”.`,
      );
      await reload(r.batchId);
    } catch (e) {
      toast(`Decision not saved: ${errorMessage(e)}`, 'error');
    }
  };

  /** Fill the review form's chart fields from the chart shown (the reviewer still checks them). */
  const fillChartFields = (fields: ChartFields) => {
    const form = formRef.current;
    if (!form) {
      toast('The review form is on the Review tab.', 'error');
      return;
    }
    for (const k of CHART_FIELDS) {
      const x = form.elements.namedItem(k);
      if (
        x instanceof HTMLInputElement ||
        x instanceof HTMLSelectElement ||
        x instanceof HTMLTextAreaElement
      )
        x.value = fields[k];
    }
    toast('Chart fields filled in the review form below. Check them before saving.');
  };

  const guard = (label: string, node: ReactNode) => (
    <ErrorBoundary label={label} resetKeys={[r.cmcId]}>
      {node}
    </ErrorBoundary>
  );

  const content: Record<CoinTab, ReactNode> = {
    review: (
      <>
        {guard(
          'The live chart',
          <ChartPanel
            cmcId={r.cmcId}
            candidates={t.chart?.candidates ?? []}
            onUseInReview={fillChartFields}
          />,
        )}
        {guard('The VMC chart', <VmcPanel t={t} />)}
        <div className="grid-2 tight">
          {guard('The price chart', <PricePanel t={t} />)}
          {guard('The venue chart', <VenuePanel t={t} />)}
        </div>
        {guard('The LBank pairs', <LbankPanel t={t} decide={(d, p) => void decide(d, p)} />)}
        {guard('The review form', <ReviewForm t={t} reload={reload} formRef={formRef} />)}
      </>
    ),
    agent: canAgent ? guard("Claude's view", <AgentPanel cmcId={r.cmcId} />) : null,
    history: (
      <>
        <ReviewHistory t={t} />
        <LbankDecisions t={t} />
        <MetadataChanges changes={changes} />
      </>
    ),
    details: (
      <>
        <CurrentObservation t={t} />
        <WindowsPanel t={t} />
        <DailyRowsPanel t={t} />
      </>
    ),
  };

  return (
    <>
      <CoinHero t={t} />
      <div
        ref={barRef}
        className="detail-tabs"
        role="tablist"
        aria-label="Coin detail sections"
        onKeyDown={onBarKey}
      >
        {tabs.map(([k, label, count]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`dt-${k}`}
            data-k={k}
            aria-controls={`dp-${k}`}
            aria-selected={k === current}
            tabIndex={k === current ? 0 : -1}
            onClick={() => show(k)}
          >
            {label}
            {count ? <b className="count">{fmtInt(count)}</b> : null}
          </button>
        ))}
      </div>
      {/* Every panel stays mounted: the agent loads at once, the review form keeps its input, the chart keeps its state. */}
      {tabs.map(([k]) => (
        <div
          key={k}
          className="detail-panel"
          role="tabpanel"
          id={`dp-${k}`}
          aria-labelledby={`dt-${k}`}
          hidden={k !== current}
        >
          {content[k]}
        </div>
      ))}
    </>
  );
}

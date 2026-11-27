// LBank price observation (docs/lbank-spot-observation.md): each CMC 1/2/3-star event since the
// cutover, observed from the moment the signal was proven usable for exactly 168 h, on two venues
// kept apart: LBank Spot (rules lbank-spot-obs-2, verified trades) and LBank Futures (rules
// lbank-futures-quote-1, observed quotes about once a minute; older rows their original method). A
// venue switch shows one venue at a time or both side by side; every detail is behind a row's
// "Details". The page refreshes itself when stored values change (two change tokens, checked every
// 30 s while visible: Spot reloads rows and summary, Futures only the rows). List state lives in the
// URL:
//   /lbank-spot?venue=compare&status=FINAL&fut=CLOSED&stars=3&cov=complete&flags=spike&from=2026-11-26&q=btc&sort=highest&dir=desc&page=2
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { SearchField } from '../../components/icons';
import {
  type Column,
  Lab,
  LoadError,
  Logo,
  Pager,
  SkeletonTable,
  Stars,
  Table,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { humanize, triggerText } from '../../lib/constants';
import {
  fmtAgo,
  fmtClock,
  fmtExact,
  fmtInt,
  fmtPct,
  fmtPrice,
  fmtTime,
  tz,
} from '../../lib/format';
import { useQueryState } from '../../lib/routes';
import { useApp, useNow } from '../../state/app';

import { openObservationDetail } from './ObservationDetail';
import { openObservationOverlaps } from './Overlaps';
import { notifyObservationChange } from './changes';
import {
  ELIGIBILITY,
  FLAG,
  FUTURES_QUOTE_LABEL,
  FUT_EVIDENCE,
  FUT_STATUS,
  FUT_STATUS_TEXT,
  QUOTE_SOURCE_TEXT,
  STATUS,
  TIME_BASIS,
  TIMING_TEXT,
  delayText,
  diffText,
  obsReasonText,
  spanText,
} from './labels';
import type {
  FuturesSampled,
  ObsSort,
  ObservationPage,
  ObservationRow,
  ObservationSummary,
  ObservationVersion,
  ObservedQuote,
} from './types';

/** A Futures row's through time in its own basis (never converted between methods). */
const futThrough = (f: FuturesSampled) => f.observedThrough ?? f.lbankSnapshotThrough;

const PAGE = 100;
const REFRESH_MS = 30_000;

type Venue = 'spot' | 'futures' | 'compare';
const VENUES: readonly (readonly [Venue, string])[] = [
  ['spot', 'Spot'],
  ['futures', 'Futures'],
  ['compare', 'Compare'],
];

const STATUS_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ...Object.entries(STATUS).map(([k, [, label]]) => [k, label] as const),
];
const FUT_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ...Object.entries(FUT_STATUS).map(([k, [, label]]) => [k, label] as const),
];
const ELIG_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ...Object.entries(ELIGIBILITY)
    .filter(([k]) => k !== 'PENDING')
    .map(([k, [, label]]) => [k, label] as const),
];
const COVERAGE_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'Any'],
  ['complete', 'No gap so far'],
  ['partial', 'With gaps'],
];
const FLAG_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'Any'],
  ['any', 'Any flag'],
  ['spike', 'Thin high or low'],
  ['delayed', 'Delayed'],
  ['none', 'No flag'],
];
const STAR_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ['1', '1★'],
  ['2', '2★'],
  ['3', '3★'],
];
const SORTS: readonly ObsSort[] = [
  'detected',
  'start',
  'stars',
  'points',
  'highest',
  'lowest',
  'referenceDelay',
  'coverage',
  'symbol',
  'futuresHighest',
  'futuresLowest',
];
const SORT_LABEL: Record<ObsSort, string> = {
  detected: 'CMC crawl time',
  start: 'window start',
  stars: 'stars',
  points: 'points',
  highest: 'Spot highest return',
  lowest: 'Spot lowest return',
  referenceDelay: 'Spot reference delay',
  coverage: 'coverage',
  symbol: 'coin',
  futuresHighest: 'Futures highest (sampled)',
  futuresLowest: 'Futures lowest (sampled)',
};

const isIn = (list: readonly (readonly [string, string])[], v: string) =>
  list.some(([k]) => k === v);
const isSort = (v: string): v is ObsSort => (SORTS as readonly string[]).includes(v);
const pctText = (v: string | null | undefined) => (v === null || v === undefined ? '—' : fmtPct(v));

function SortHead({
  k,
  label,
  sort,
  dir,
  onSort,
}: {
  k: ObsSort;
  label: string;
  sort: ObsSort;
  dir: 'asc' | 'desc';
  onSort: (k: ObsSort) => void;
}) {
  const on = sort === k;
  return (
    <button
      type="button"
      className={`sort-btn${on ? ' on' : ''}`}
      aria-label={`Sort by ${SORT_LABEL[k]}${on ? (dir === 'desc' ? ', now highest first' : ', now lowest first') : ''}`}
      onClick={() => onSort(k)}
    >
      {label}
      <i aria-hidden="true">{on ? (dir === 'desc' ? '↓' : '↑') : '↕'}</i>
    </button>
  );
}

function Seg({
  label,
  items,
  value,
  onPick,
}: {
  label: string;
  items: readonly (readonly [string, string])[];
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Select({
  label,
  items,
  value,
  onPick,
  title,
}: {
  label: string;
  items: readonly (readonly [string, string])[];
  value: string;
  onPick: (v: string) => void;
  title?: string;
}) {
  return (
    <label className="select-field" title={title}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onPick(e.target.value)}>
        {items.map(([k, text]) => (
          <option key={k} value={k}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Today's times as a clock time, other days with their date (display time zone). */
function fmtShort(iso: string): string {
  const day = (d: Date) => d.toLocaleDateString('en-GB', { timeZone: tz() });
  return day(new Date(iso)) === day(new Date()) ? fmtClock(iso) : fmtTime(iso);
}

/** Coin, stars and weighted points in one cell. */
const ObsCoin = ({ r }: { r: ObservationRow }) => (
  <div className="coin obs-coin">
    <Logo cmcId={r.cmcId} />
    <div className="coin-text">
      <b>
        {r.symbol} <Stars n={r.stars} />
      </b>
      <span
        title={`${r.name} · CMC id ${r.cmcId}${r.points === null ? '' : ` · ${r.points}${r.scoreComplete === false ? ' ≥' : ''} weighted points`}`}
      >
        {r.name}
      </span>
    </div>
  </div>
);

/** A value on top, its context underneath (two lines instead of one crowded line). */
const Two = ({
  v,
  s,
  title,
  tone,
}: {
  v: ReactNode;
  s?: ReactNode;
  title?: string;
  tone?: string;
}) => (
  <div className={`obs-two${tone ? ` ${tone}` : ''}`} title={title}>
    <span className="v">{v}</span>
    {s ? <span className="s">{s}</span> : null}
  </div>
);

/** Final or provisional, as a word (never a number's color alone). */
const Finality = ({ final }: { final: boolean }) => (
  <span className={`obs-final${final ? ' on' : ''}`}>{final ? 'Final' : 'Provisional'}</span>
);

// ── Spot cells ─────────────────────────────────────────────────────────────────────────────

/** Why a Spot reference is still pending, from the times alone (no guess about the cause). */
function pendingText(r: ObservationRow, now: number): string {
  if (!r.window) return 'waiting for the window start';
  const readable = Math.floor(Date.parse(r.window.start) / 60_000) * 60_000 + 65_000;
  if (now < readable) return 'start minute still open';
  return r.freshness.lastFetchError
    ? 'last LBank request failed: retried'
    : 'awaiting the next check';
}

function SpotReference({ r, now }: { r: ObservationRow; now: number }) {
  const ref = r.reference;
  if (ref.price !== null && ref.delayMs !== null)
    return (
      <Two
        v={
          <>
            {fmtPrice(ref.price)}
            {ref.delayed ? <span className="chip warn small">Delayed</span> : null}
          </>
        }
        s={`${delayText(ref.delayMs)} after start`}
        title={`First verified LBank Spot trade at or after the window start.\ntrade ${ref.tradeId} at ${fmtExact(ref.at)}, qty ${ref.qty}\nThe delay is market time (start → trade), not how long the page took to update.`}
      />
    );
  if (r.status === 'NO_TRADES') return <Two v="no trade" s="none in the whole window" />;
  if (ref.status === 'PENDING') return <Two v="Pending" s={pendingText(r, now)} tone="muted" />;
  return <Two v={humanize(ref.status)} s={r.reasons.map(obsReasonText)[0]} tone="muted" />;
}

function SpotExtreme({ r, kind }: { r: ObservationRow; kind: 'highest' | 'lowest' }) {
  const v = r[kind];
  if (!v) return <span className="muted">{r.status === 'NO_TRADES' ? 'no trade' : '—'}</span>;
  return (
    <Two
      v={pctText(v.pct)}
      s={fmtPrice(v.price)}
      tone={r.provisional ? 'prov' : undefined}
      title={`${kind === 'highest' ? 'Highest' : 'Lowest'} verified LBank Spot trade ${v.price} at ${fmtExact(v.at)} (trade ${v.tradeId})\n${pctText(v.pct)} vs the Spot reference trade. An observed price, not profit${kind === 'lowest' ? ', not a stop' : ''}.${r.provisional ? '\nProvisional: the window is running or data is still being verified.' : ''}`}
    />
  );
}

// ── Futures cells ──────────────────────────────────────────────────────────────────────────

const futMissing = (f: FuturesSampled | null): string =>
  !f ? 'not created yet' : (FUT_STATUS_TEXT[f.status] ?? humanize(f.status).toLowerCase());

/** Times of an observed quote, for tooltips (our request's times; LBank gives no trade time). */
const quoteTimes = (q: ObservedQuote, start: string) =>
  [
    `Observed (response received) ${fmtExact(q.observedAt)}: ${delayText(q.delayMs)} after the signal was published (${fmtExact(start)}).`,
    `Request sent ${fmtExact(q.requestStartedAt)} (${delayText(q.publicationToRequestMs)} after publication), answered in ${spanText(q.requestToResponseMs)}; stored ${fmtExact(q.storedAt)}.`,
    `Sent by: ${QUOTE_SOURCE_TEXT[q.source] ?? q.source}${q.failedAttemptsBefore ? `; ${q.failedAttemptsBefore} failed attempt(s) before` : ''}.`,
    'LBank’s lastPrice may come from a trade before the signal; its response has no trade time. Not an order fill.',
  ].join('\n');

function FuturesReference({ r }: { r: ObservationRow }) {
  const f = r.futuresSampled;
  if (!f || !r.window)
    return (
      <span className="muted" title={futMissing(f)}>
        —
      </span>
    );
  if (f.method === 'OBSERVED_QUOTE') {
    if (!f.quote)
      return (
        <span className="muted" title={futMissing(f)}>
          —
        </span>
      );
    return (
      <Two
        v={fmtPrice(f.quote.price)}
        s={`observed ${delayText(f.quote.delayMs)} after signal`}
        title={`${FUTURES_QUOTE_LABEL}.\n${quoteTimes(f.quote, r.window.start)}`}
      />
    );
  }
  if (!f.reference)
    return (
      <span className="muted" title={futMissing(f)}>
        —
      </span>
    );
  return (
    <Two
      v={fmtPrice(f.reference.price)}
      s="old method"
      tone="muted"
      title={`Old method (${f.rulesVersion}): the later of two minute snapshots between which LBank’s 24 h turnover rose (snapshots at ${fmtExact(f.reference.after)} and before ${fmtExact(f.reference.before)}). Not the first Futures price observed after the signal and not a trade time; kept as recorded.${f.postFixQuote ? `\nFirst price observed after the fix: ${f.postFixQuote.price} at ${fmtExact(f.postFixQuote.observedAt)} (${delayText(f.postFixQuote.delayMs)} after the signal) — not an entry quote.` : ''}`}
    />
  );
}

function FuturesExtreme({ r, kind }: { r: ObservationRow; kind: 'highest' | 'lowest' }) {
  const f = r.futuresSampled;
  const v = f?.[kind];
  if (!f || !v)
    return (
      <span className="muted" title={futMissing(f)}>
        —
      </span>
    );
  const observed = f.method === 'OBSERVED_QUOTE';
  return (
    <Two
      v={`${observed ? '' : kind === 'highest' ? '≥ ' : '≤ '}${pctText(v.pct)}`}
      s={fmtPrice(v.price)}
      tone={f.provisional ? 'prov' : undefined}
      title={
        observed
          ? `${kind === 'highest' ? 'Highest' : 'Lowest'} Futures price our requests observed in the window: ${v.price} at ${fmtExact(v.observedAt)}, vs the first observed Futures price. Observed quotes at our sampling times, not verified trades; LBank’s 24 h high/low is not used.`
          : `Old method: ${kind === 'highest' ? 'highest' : 'lowest'} price from turnover-rise snapshot pairs (${fmtExact(v.after)} – ${fmtExact(v.before)}); a bound, vs the old-method reference.`
      }
    />
  );
}

function FuturesStatusCell({ r }: { r: ObservationRow }) {
  const f = r.futuresSampled;
  if (!f) return <span className="muted">not created yet</span>;
  const ev = FUT_EVIDENCE[f.evidenceClass];
  return (
    <div className="obs-status">
      <Lab map={FUT_STATUS} k={f.status} />
      <span className="muted small">
        {f.reasons.length
          ? f.reasons.map(obsReasonText).join(' · ')
          : (FUT_STATUS_TEXT[f.status] ?? '')}
      </span>
      {ev ? (
        <span className={`small${f.immediateEntry ? '' : ' muted'}`} title={ev[1]}>
          {ev[0]}
        </span>
      ) : null}
    </div>
  );
}

/** How far a Futures row was observed, in its own time base, with samples and the longest gap. */
function FuturesThroughCell({ r }: { r: ObservationRow }) {
  const f = r.futuresSampled;
  if (!f || f.mapping !== 'OK') return <span className="muted">—</span>;
  const at = futThrough(f);
  const [label, meaning] = TIME_BASIS[f.throughBasis] ?? [f.throughBasis, ''];
  return (
    <Two
      v={at ? `${label} ${fmtShort(at)}` : 'not sampled'}
      s={`${fmtInt(f.samplesInWindow)} observation${f.samplesInWindow === 1 ? '' : 's'} · max gap ${spanText(f.maxGapMs)}${f.method === 'OBSERVED_QUOTE' ? '' : ' · old method'}`}
      title={`${label} ${fmtExact(at)}: ${meaning}.
Longest interval without an observation: ${spanText(f.maxGapMs)} (same time base).
Once-a-minute samples can miss a move between them: observed values, not proof of the exact high or low.`}
    />
  );
}

/**
 * Compare → status and data through, per venue: how far each venue's values reach (each in its own
 * time base) and, when they are more than a minute apart, by how much (highlighted).
 */
function CompareStatus({ r }: { r: ObservationRow }) {
  const c = r.coverageTimes;
  const f = r.futuresSampled;
  const basis = f ? (TIME_BASIS[f.throughBasis] ?? [f.throughBasis, '']) : null;
  const futWord = f?.throughBasis === 'LBANK_SNAPSHOT_TIME' ? 'LBank time' : 'observed';
  return (
    <div className="obs-pair">
      <span className="venue">Spot</span>
      <Two
        v={
          <>
            <Finality final={r.status === 'FINAL'} /> <Lab map={STATUS} k={r.status} />
          </>
        }
        s={
          c.spotDataThrough ? `data through ${fmtShort(c.spotDataThrough)}` : 'no data fetched yet'
        }
        title={`Spot: one-minute candles fetched through ${fmtExact(c.spotDataThrough)} (exclusive); highest and lowest are verified trades before it.${c.spotLastFetchAt ? `\nLast successful LBank fetch ${fmtExact(c.spotLastFetchAt)}.` : ''}`}
      />
      <span className="venue">Fut</span>
      {f ? (
        <Two
          v={<Lab map={FUT_STATUS} k={f.status} title={futMissing(f)} />}
          s={
            c.futuresThrough
              ? `${futWord} through ${fmtShort(c.futuresThrough)}${c.differs && c.differenceMs !== null ? ` · ${diffText(c.differenceMs)} vs Spot` : ''}`
              : '—'
          }
          tone={c.differs ? 'warn' : undefined}
          title={`Futures ${basis?.[0] ?? 'through'} ${fmtExact(c.futuresThrough)} (${basis?.[1] ?? ''}).${c.differenceMs === null ? '' : `\nFutures through − Spot data through = ${diffText(c.differenceMs)}: ${c.differs ? 'the venues’ values cover visibly different spans (more than a minute apart) — not a same-moment comparison' : 'within a minute of each other (still not the same instants)'}.`}`}
        />
      ) : (
        <span className="muted">—</span>
      )}
    </div>
  );
}

/** The two publication requests side by side: initiated together, never simultaneous. */
function PublicationLine({ r }: { r: ObservationRow }) {
  const s = r.spotIndicative;
  const p = r.publicationQuotes;
  if (!s) return null;
  return (
    <span
      className="muted small obs-pub"
      title={`Spot price at publication (indicative): ${s.price} for ${s.pair}, from LBank’s all-pairs price request — not the Spot reference (a verified trade), never in a Spot return.
Request queued ${fmtExact(s.requestQueuedAt)}, sent ${fmtExact(s.requestStartedAt)}, answered ${fmtExact(s.observedAt)} (${delayText(s.delayMs)} after publication); LBank response time ${fmtExact(s.lbankResponseAt)} (not a trade time).${
        p
          ? `
Vs the Futures quote: sent ${diffText(p.sentDifferenceMs)}, answered ${diffText(p.receivedDifferenceMs)} later${p.queuedTogether ? ' (both queued at the publication; requests are paced, so never at the same instant)' : ''}.`
          : ''
      }`}
    >
      {`Spot quote at publication ${fmtPrice(s.price)}${p ? ` · ${diffText(p.receivedDifferenceMs)} vs Futures` : ''}`}
    </span>
  );
}

function Flags({ r }: { r: ObservationRow }) {
  const flags = [...r.flags, ...(r.futuresSampled?.flags ?? [])];
  if (!flags.length && !r.overlapping) return null;
  return (
    <span className="chips">
      {flags.map((f) => (
        <span key={f} className="chip warn small" title={FLAG[f]?.[1] ?? humanize(f)}>
          {FLAG[f]?.[0] ?? humanize(f)}
        </span>
      ))}
      {r.overlapping ? (
        <button
          type="button"
          className="chip link-chip small"
          title={`${r.symbol} has ${r.coinEvents} observations; ${r.overlapping} of them have 168-hour windows that overlap this one. Not a flag: each stays its own observation. Click for the list.`}
          onClick={() => openObservationOverlaps(r)}
        >
          {`${r.overlapping} overlapping`}
        </button>
      ) : null}
    </span>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────────────────

function FreshnessBar({
  sum,
  version,
  loadedAt,
  now,
}: {
  sum: ObservationSummary;
  version: { v: ObservationVersion; at: number } | null;
  loadedAt: number | null;
  now: number;
}) {
  const run = sum.lastRun;
  const fut = version?.v.futures ?? null;
  const poll = fut?.lastPoll ?? (sum.futures.lastPoll ? { ...sum.futures.lastPoll } : null);
  const spotThrough = sum.freshness.oldestOpenDataThrough;
  const futThroughAt = fut?.oldestOpenObservedThrough ?? null;
  return (
    <div className="obs-bar" role="status">
      <div
        title={
          spotThrough
            ? `Oldest open Spot window: one-minute candles fetched through ${fmtExact(spotThrough)} (exclusive); its verified trades lie before that. Fetched by the observation job (every 15 min and after each new event).`
            : undefined
        }
      >
        <span className="k">Spot data through</span>
        <b>{spotThrough ? fmtTime(spotThrough) : '—'}</b>
        <span className="muted small">
          {spotThrough ? ` oldest open window, ${fmtAgo(spotThrough, now)}` : ''}
        </span>
      </div>
      <div title={run ? run.notes.at(-1) : undefined}>
        <span className="k">Last observation job</span>
        <b>{run?.finishedAt ? fmtTime(run.finishedAt) : run ? 'running…' : '—'}</b>
        <span className="muted small">
          {run
            ? ` ${triggerText(run.trigger)}, ${run.fetchedNewData ? 'fetched new LBank data' : 'recomputed only'}`
            : ''}
        </span>
      </div>
      <div
        title={`Futures (observed-quote rows still open): the oldest “observed through” time = when our latest response for that row was received; prices are sampled about once a minute.${poll ? `\nLast Futures request answered ${fmtExact(poll.fetchedAt)}${poll.ok ? '' : ' (failed: retried next minute)'}.` : ''}`}
      >
        <span className="k">Futures observed through</span>
        <b>{futThroughAt ? fmtTime(futThroughAt) : '—'}</b>
        <span className="muted small">
          {futThroughAt
            ? ` oldest open window, ${fmtAgo(futThroughAt, now)}`
            : poll
              ? ` last request ${fmtAgo(poll.fetchedAt, now)}`
              : ''}
          {poll && !poll.ok ? ' · last request failed' : ''}
        </span>
      </div>
      <div
        title={`Checks for new values every 30 s while visible (one small request). A Spot change reloads rows and summary; a Futures-only change reloads the rows. Last check ${version ? fmtExact(new Date(version.at).toISOString()) : '—'}; data loaded ${loadedAt ? fmtExact(new Date(loadedAt).toISOString()) : '—'}.`}
      >
        <span className="k">This page</span>
        <b>{loadedAt ? fmtAgo(new Date(loadedAt).toISOString(), now) : '—'}</b>
        <span className="muted small"> reloads when Spot or Futures values change</span>
      </div>
    </div>
  );
}

/**
 * Secondary filters in a floating panel under its button: opening it never moves the toolbar or
 * the table. Closes on an outside click, Escape, or "Done"; the button shows how many are set.
 */
function MoreFilters({
  active,
  onClear,
  children,
}: {
  active: number;
  onClear: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="obs-more" ref={box}>
      <button
        type="button"
        className={`obs-more-btn${active ? ' on' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {`More filters${active ? ` · ${active}` : ''}`}
        <i aria-hidden="true">{open ? '▴' : '▾'}</i>
      </button>
      {open ? (
        <div className="obs-more-pop" role="dialog" aria-label="More filters">
          <div className="obs-more-grid">{children}</div>
          <div className="obs-more-foot">
            <button type="button" className="btn small" onClick={onClear} disabled={!active}>
              Clear
            </button>
            <button type="button" className="btn small primary" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Observation() {
  const { openCoin, dataVersion, setNavCount } = useApp();
  const now = useNow(15_000);
  const [query, setQuery] = useQueryState({
    venue: 'spot',
    status: '',
    fut: '',
    elig: '',
    cov: '',
    flags: '',
    stars: '',
    from: '',
    to: '',
    q: '',
    sort: 'detected',
    dir: 'desc',
    page: '1',
  });
  const venue: Venue =
    (['spot', 'futures', 'compare'] as const).find((v) => v === query.venue) ?? 'spot';
  const status = isIn(STATUS_FILTERS, query.status) ? query.status : '';
  const fut = isIn(FUT_FILTERS, query.fut) ? query.fut : '';
  const elig = isIn(ELIG_FILTERS, query.elig) ? query.elig : '';
  const cov = isIn(COVERAGE_FILTERS, query.cov) ? query.cov : '';
  const flags = isIn(FLAG_FILTERS, query.flags) ? query.flags : '';
  const stars = isIn(STAR_FILTERS, query.stars) ? query.stars : '';
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : '';
  const sort: ObsSort = isSort(query.sort) ? query.sort : 'detected';
  const dir = query.dir === 'asc' ? 'asc' : 'desc';
  const search = query.q.trim();
  const pageNum = Number(query.page);
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum - 1 : 0;
  const moreActive = [elig, cov, flags, from, to].filter(Boolean).length;

  const [searchText, setSearchText] = useState(query.q);
  const [data, setData] = useState<{ sum: ObservationSummary; list: ObservationPage } | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [version, setVersion] = useState<{ v: ObservationVersion; at: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tokens = useRef({ spot: '', futures: '' });

  useEffect(() => {
    setSearchText((t) => (t.trim() === query.q.trim() ? t : query.q));
  }, [query.q]);

  const filters = useMemo(() => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (fut) q.set('futures', fut);
    if (elig) q.set('eligibility', elig);
    if (cov) q.set('coverage', cov);
    if (flags) q.set('flags', flags);
    if (stars) q.set('stars', stars);
    // UTC calendar dates of the CMC crawl (the event's date; [from 00:00, to + 1 day 00:00)).
    if (from) q.set('from', `${from}T00:00:00Z`);
    if (to) q.set('to', new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString());
    if (search) q.set('search', search);
    return q;
  }, [status, fut, elig, cov, flags, stars, from, to, search]);

  /**
   * `rows`: only the visible rows (a Futures-only change); `all`: rows and the summary. The change
   * tokens are read BEFORE the data, so the token kept is never newer than the values shown: a
   * change committed in between moves the token again and is fetched at the next check.
   */
  const load = useCallback(
    async (scope: 'all' | 'rows' = 'all') => {
      const q = new URLSearchParams(filters);
      q.set('sort', sort);
      q.set('dir', dir);
      q.set('limit', String(PAGE));
      q.set('offset', String(page * PAGE));
      try {
        const v = await api<ObservationVersion>('observations/version');
        // The unfiltered summary: the nav count (active events), freshness and the cutover.
        const [sum, list] = await Promise.all([
          scope === 'all' ? api<ObservationSummary>('observations/summary') : null,
          api<ObservationPage>(`observations?${q}`),
        ]);
        tokens.current = { spot: v.spotToken, futures: v.futuresToken };
        setVersion({ v, at: Date.now() });
        if (sum) setNavCount('observation', sum.summary.byStatus.ACTIVE?.events ?? 0);
        setData((d) => (sum ? { sum, list } : d ? { ...d, list } : d));
        setLoadedAt(Date.now());
        setError(null);
      } catch (e) {
        console.error(e);
        setError(e);
      }
    },
    [filters, sort, dir, page, setNavCount],
  );

  useEffect(() => {
    void load();
  }, [dataVersion, load]);
  useEffect(() => () => clearTimeout(debounce.current), []);

  // Display freshness: every 30 s while the page is visible (and on return to it) one cheap version
  // read; a Spot change (job run, stored Spot values) reloads rows and summary, a Futures-only change
  // (a displayed Futures value, a publication quote, an order book) reloads the rows. Open dialogs
  // are told to reload as well.
  useEffect(() => {
    const check = async () => {
      if (document.hidden) return;
      try {
        const v = await api<ObservationVersion>('observations/version');
        setVersion({ v, at: Date.now() });
        const spot = !!tokens.current.spot && v.spotToken !== tokens.current.spot;
        const futures = !!tokens.current.futures && v.futuresToken !== tokens.current.futures;
        if (!spot && !futures) return;
        await load(spot ? 'all' : 'rows');
        notifyObservationChange({ spot, futures });
      } catch {
        /* the shell's 30 s tick reports API errors */
      }
    };
    const id = setInterval(() => void check(), REFRESH_MS);
    const onVis = () => void check();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  const onSearch = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setSearchText(v);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setQuery({ q: v.trim(), page: null }), 250);
  };

  const onSort = useCallback(
    (k: ObsSort) =>
      setQuery(
        k !== sort
          ? { sort: k, dir: 'desc', page: null }
          : dir === 'desc'
            ? { dir: 'asc', page: null }
            : { sort: null, dir: null, page: null },
        { push: true },
      ),
    [sort, dir, setQuery],
  );

  const cols = useMemo<Column<ObservationRow>[]>(() => {
    const head = (k: ObsSort, label: string) => (
      <SortHead k={k} label={label} sort={sort} dir={dir} onSort={onSort} />
    );
    const coin: Column<ObservationRow> = {
      label: (
        <span className="obs-heads">
          {head('symbol', 'Coin')}
          {head('stars', '★')}
        </span>
      ),
      render: (r) => <ObsCoin r={r} />,
    };
    const signal: Column<ObservationRow> = {
      label: head('start', 'Window start'),
      title:
        'When the Review Queue holding the signal was published (the window is exactly 168 h from here); underneath, how long after the CMC crawl that was',
      render: (r) =>
        r.window ? (
          <Two
            v={fmtShort(r.window.start)}
            s={`${delayText(r.window.afterCrawlMs)} after crawl`}
            title={`Window ${fmtExact(r.window.start)} – ${fmtExact(r.window.end)}\nCMC crawl ${fmtExact(r.crawlAt)} (names the event)\nproven by: ${TIMING_TEXT[r.window.source] ?? r.window.source}${r.window.uncertain ? ' (later than the earliest usable moment)' : ''}`}
          />
        ) : (
          <Two v="Pending" s={`CMC crawl ${fmtTime(r.crawlAt)}`} tone="muted" />
        ),
    };
    const details: Column<ObservationRow> = {
      label: '',
      title: 'Everything behind this observation, both venues',
      render: (r) => (
        <button
          type="button"
          className="btn small"
          aria-label={`Details of ${r.symbol} ${r.stars} stars`}
          onClick={() => openObservationDetail(r)}
        >
          Details
        </button>
      ),
    };
    const spotStatus: Column<ObservationRow> = {
      label: head('coverage', 'Status · data · flags'),
      title:
        'Final or provisional and the status; how far LBank Spot data was fetched (data freshness) and gaps; review flags (not errors) and overlapping windows. Sorted by coverage.',
      render: (r) => {
        // "Window running" is what Provisional already says.
        const reasons = r.reasons.filter((x) => x !== 'WINDOW_OPEN');
        const gaps = r.coverage.gaps.length;
        return (
          <div className="obs-status">
            <span className="obs-status-line">
              <Finality final={r.status === 'FINAL'} /> <Lab map={STATUS} k={r.status} />
            </span>
            {reasons.length ? (
              <span className="muted small" title={reasons.map(obsReasonText).join('\n')}>
                {obsReasonText(reasons[0]!)}
                {reasons.length > 1 ? ` (+${reasons.length - 1})` : ''}
              </span>
            ) : null}
            <span
              className="muted small"
              title={`Data through ${fmtExact(r.freshness.dataThrough)} (${fmtAgo(r.freshness.dataThrough, now)})\n${fmtInt(r.coverage.minutesPresent)} of ${fmtInt(r.coverage.minutesExpected)} minutes with a candle, ${fmtInt(r.coverage.minutesTraded)} traded\nlast LBank fetch ${fmtExact(r.freshness.lastSourceFetchAt)}\nlast recomputed ${fmtExact(r.freshness.lastRecomputedAt)} (recomputing is not fresh data)${r.freshness.lastFetchError ? `\nlast error: ${r.freshness.lastFetchError}` : ''}`}
            >
              {r.freshness.dataThrough
                ? `data through ${fmtShort(r.freshness.dataThrough)}`
                : 'no data fetched yet'}
              {gaps ? ` · ${gaps} gap${gaps > 1 ? 's' : ''}` : ''}
            </span>
            <Flags r={r} />
          </div>
        );
      },
    };
    if (venue === 'futures')
      return [
        coin,
        signal,
        {
          label: 'Contract',
          render: (r) =>
            r.futuresSampled?.contract ? (
              <Two v={r.futuresSampled.contract} s="mapped by CMC id" />
            ) : (
              <Two
                v="—"
                s={r.futuresSampled ? humanize(r.futuresSampled.mapping).toLowerCase() : 'pending'}
                tone="muted"
              />
            ),
        },
        {
          label: 'First price observed',
          title:
            'The first Futures price our requests observed after the signal (response receipt), and its real delay. Old-method rows are labelled “old method”.',
          render: (r) => <FuturesReference r={r} />,
        },
        {
          label: head('futuresHighest', 'Highest'),
          num: true,
          title:
            'Highest Futures price our requests observed in the window, vs the first observed price (old method: a bound, marked ≥)',
          render: (r) => <FuturesExtreme r={r} kind="highest" />,
        },
        {
          label: head('futuresLowest', 'Lowest'),
          num: true,
          title:
            'Lowest Futures price our requests observed in the window, vs the first observed price (old method: a bound, marked ≤)',
          render: (r) => <FuturesExtreme r={r} kind="lowest" />,
        },
        {
          label: 'Futures status',
          title:
            'Status, its reason, and what the stored records establish about the entry (only “Immediate quote” is an immediate Futures entry)',
          render: (r) => <FuturesStatusCell r={r} />,
        },
        {
          label: 'Observed through',
          title:
            'How far the window was observed, each method in its own time base: “observed through” = when our latest response arrived; old-method rows show LBank’s snapshot time instead. Underneath: observations in the window and the longest gap between them.',
          render: (r) => <FuturesThroughCell r={r} />,
        },
        details,
      ];
    if (venue === 'compare')
      return [
        coin,
        signal,
        {
          label: 'Reference',
          title:
            'Spot: the first verified trade after the start (its trade time). Futures: the first price our request observed after the publication (its response time). Different kinds of time; underneath, the indicative Spot quote from the publication request, if any.',
          render: (r) => (
            <div className="obs-pair">
              <span className="venue">Spot</span>
              <SpotReference r={r} now={now} />
              <span className="venue">Fut</span>
              <FuturesReference r={r} />
              <PublicationLine r={r} />
            </div>
          ),
        },
        {
          label: (
            <span className="obs-th2">
              {head('highest', 'Highest')}
              <small>Spot verified · Fut sampled</small>
            </span>
          ),
          title:
            'Spot: verified trades. Futures: the highest price our once-a-minute requests observed (a move between samples can be missed). Each vs its own reference, each through its own time (Status · data through).',
          render: (r) => (
            <div className="obs-pair">
              <span className="venue">Spot</span>
              <SpotExtreme r={r} kind="highest" />
              <span className="venue">Fut</span>
              <FuturesExtreme r={r} kind="highest" />
            </div>
          ),
        },
        {
          label: (
            <span className="obs-th2">
              {head('lowest', 'Lowest')}
              <small>Spot verified · Fut sampled</small>
            </span>
          ),
          title:
            'Spot: verified trades. Futures: the lowest price our once-a-minute requests observed (a move between samples can be missed). Each vs its own reference, each through its own time (Status · data through).',
          render: (r) => (
            <div className="obs-pair">
              <span className="venue">Spot</span>
              <SpotExtreme r={r} kind="lowest" />
              <span className="venue">Fut</span>
              <FuturesExtreme r={r} kind="lowest" />
            </div>
          ),
        },
        {
          label: 'Status · data through',
          title:
            'Each venue’s status and how far its values reach: Spot = one-minute candles fetched (verified trades lie before it); Futures = our latest observation (old-method rows: LBank’s snapshot time). Highlighted, with the difference, when they are more than a minute apart.',
          render: (r) => <CompareStatus r={r} />,
        },
        details,
      ];
    return [
      coin,
      signal,
      {
        label: head('referenceDelay', 'Reference'),
        title:
          'The first verified LBank Spot trade at or after the window start; underneath, its market delay (start → trade). An observed trade, not an executed order.',
        render: (r) => <SpotReference r={r} now={now} />,
      },
      {
        label: head('highest', 'Highest'),
        num: true,
        title:
          'Maximum rise vs the reference: 100 × (highest verified trade ÷ reference − 1). Not profit.',
        render: (r) => <SpotExtreme r={r} kind="highest" />,
      },
      {
        label: head('lowest', 'Lowest'),
        num: true,
        title: 'Maximum decline vs the reference, independent of the highest. Not a stop loss.',
        render: (r) => <SpotExtreme r={r} kind="lowest" />,
      },
      spotStatus,
      details,
    ];
  }, [sort, dir, onSort, venue, now]);

  const empty = data?.sum.cutover.cutoverAt
    ? 'No observation matches these filters.'
    : 'No observation yet: the cutover is not set, so every star event still goes to the legacy forward test.';
  const pick = (k: string) => (v: string) => setQuery({ [k]: v, page: null }, { push: true });
  return (
    <>
      {data ? (
        <FreshnessBar sum={data.sum} version={version} loadedAt={loadedAt} now={now} />
      ) : null}
      <div className="toolbar obs-toolbar">
        <Seg
          label="Venue"
          items={VENUES}
          value={venue}
          onPick={(v) => setQuery({ venue: v === 'spot' ? null : v }, { push: true })}
        />
        <SearchField
          label="Filter by coin, CMC id or pair"
          value={searchText}
          onChange={onSearch}
        />
        <Seg label="Stars" items={STAR_FILTERS} value={stars} onPick={pick('stars')} />
        {venue !== 'futures' ? (
          <Select
            label="Spot status"
            items={STATUS_FILTERS}
            value={status}
            onPick={pick('status')}
          />
        ) : null}
        {venue !== 'spot' ? (
          <Select label="Futures status" items={FUT_FILTERS} value={fut} onPick={pick('fut')} />
        ) : null}
        <MoreFilters
          active={moreActive}
          onClear={() =>
            setQuery(
              { elig: null, cov: null, flags: null, from: null, to: null, page: null },
              { push: true },
            )
          }
        >
          <Select
            label="Listing evidence"
            items={ELIG_FILTERS}
            value={elig}
            onPick={pick('elig')}
            title="Spot at the signal and Futures listing snapshots"
          />
          <Select label="Coverage" items={COVERAGE_FILTERS} value={cov} onPick={pick('cov')} />
          <Select
            label="Flags"
            items={FLAG_FILTERS}
            value={flags}
            onPick={pick('flags')}
            title="Review flags stay in every count; this only filters the table"
          />
          <label
            className="select-field"
            title="UTC date of the CMC crawl (the event's date), from"
          >
            <span>Crawl from (UTC date)</span>
            <input type="date" value={from} onChange={(e) => pick('from')(e.target.value)} />
          </label>
          <label className="select-field" title="UTC date of the CMC crawl, to (inclusive)">
            <span>Crawl to (UTC date)</span>
            <input type="date" value={to} onChange={(e) => pick('to')(e.target.value)} />
          </label>
        </MoreFilters>
      </div>
      {error ? <div className="banner inline">{errorMessage(error)}</div> : null}
      <div className="panel flush obs-panel">
        <div className="table-wrap">
          {error ? (
            <LoadError error={error} />
          ) : data ? (
            <Table
              cols={cols}
              rows={data.list.rows}
              empty={empty}
              onRow={(r) => openCoin(r.cmcId)}
              rowKey={(r, i) => r.id || i}
            />
          ) : (
            <SkeletonTable rows={12} label="Loading observations…" />
          )}
        </div>
      </div>
      <div className="pager">
        {data ? (
          <Pager
            page={page}
            pageSize={PAGE}
            total={data.list.total}
            unit="observations"
            onPage={(p) => setQuery({ page: p > 0 ? p + 1 : null }, { push: true })}
          />
        ) : null}
      </div>
    </>
  );
}

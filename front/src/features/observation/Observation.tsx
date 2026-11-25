// LBank Spot price observation (docs/lbank-spot-observation.md, rules lbank-spot-obs-2): each CMC
// 1/2/3-star event since the cutover, observed on LBank Spot from the moment the signal was proven
// usable for exactly 168 h: the first verified trade after it (reference), the highest and lowest
// verified trades. Only the table and its filters: the summary, export and "Update now" are on the
// Data page (ObservationInsights), every detail behind a row's "Details", the rules behind the help
// button. List state lives in the URL:
//   /lbank-spot?status=FINAL&elig=SPOT_ONLY&stars=3&cov=complete&flags=spike&from=2026-11-26&q=btc&sort=highest&dir=desc&page=2
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SearchField } from '../../components/icons';
import {
  CoinCell,
  type Column,
  Lab,
  LoadError,
  Pager,
  SkeletonTable,
  Stars,
  Table,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { humanize } from '../../lib/constants';
import { fmtAgo, fmtInt, fmtPct, fmtPrice, fmtTime, utc } from '../../lib/format';
import { useQueryState } from '../../lib/routes';
import { useApp } from '../../state/app';

import { openObservationDetail } from './ObservationDetail';
import { openObservationOverlaps } from './Overlaps';
import {
  ELIGIBILITY,
  FLAG,
  FUTURES_TEXT,
  GAP_TEXT,
  LISTING_TEXT,
  MAPPING_TEXT,
  ORDER,
  STATUS,
  TIMING_TEXT,
  TRADING_TEXT,
  delayText,
  obsReasonText,
} from './labels';
import type { ObsSort, ObservationPage, ObservationRow, ObservationSummary } from './types';

const PAGE = 100;

const STATUS_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All statuses'],
  ...Object.entries(STATUS).map(([k, [, label]]) => [k, label] as const),
];
const ELIG_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ...Object.entries(ELIGIBILITY)
    .filter(([k]) => k !== 'PENDING')
    .map(([k, [, label]]) => [k, label] as const),
];
const COVERAGE_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'Any coverage'],
  ['complete', 'No gap so far'],
  ['partial', 'With gaps'],
];
const FLAG_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'Any flags'],
  ['any', 'Flagged'],
  ['spike', 'Thin-market extreme'],
  ['delayed', 'Delayed reference'],
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
];
const SORT_LABEL: Record<ObsSort, string> = {
  detected: 'CMC crawl time',
  start: 'window start',
  stars: 'stars',
  points: 'points',
  highest: 'highest return',
  lowest: 'lowest return',
  referenceDelay: 'reference delay',
  coverage: 'coverage',
  symbol: 'coin',
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

function ExtremeCell({
  r,
  v,
  kind,
}: {
  r: ObservationRow;
  v: ObservationRow['highest'];
  kind: 'highest' | 'lowest';
}) {
  if (!v) return <span className="muted">{r.status === 'NO_TRADES' ? 'no trade' : '—'}</span>;
  return (
    <span
      className={r.provisional ? 'muted' : undefined}
      title={[
        `${kind === 'highest' ? 'Highest' : 'Lowest'} verified LBank Spot trade ${v.price} at ${utc(v.at)} (trade ${v.tradeId})`,
        `${pctText(v.pct)} vs the reference trade; not profit${kind === 'lowest' ? ', not a stop loss' : ''}`,
        r.order ? ORDER[r.order] : '',
        r.provisional ? 'provisional (not Final)' : '',
      ]
        .filter(Boolean)
        .join('\n')}
    >
      {pctText(v.pct)}
      {r.provisional ? ' *' : ''}
      <span className="muted small">{` · ${fmtPrice(v.price)} · ${fmtTime(v.at)}`}</span>
    </span>
  );
}

export default function Observation() {
  const { openCoin, dataVersion, setNavCount } = useApp();
  const [query, setQuery] = useQueryState({
    status: '',
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
  const status = isIn(STATUS_FILTERS, query.status) ? query.status : '';
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

  const [searchText, setSearchText] = useState(query.q);
  const [data, setData] = useState<{ sum: ObservationSummary; list: ObservationPage } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setSearchText((t) => (t.trim() === query.q.trim() ? t : query.q));
  }, [query.q]);

  const filters = useMemo(() => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (elig) q.set('eligibility', elig);
    if (cov) q.set('coverage', cov);
    if (flags) q.set('flags', flags);
    if (stars) q.set('stars', stars);
    // UTC calendar dates of the CMC crawl (the event's date; [from 00:00, to + 1 day 00:00)).
    if (from) q.set('from', `${from}T00:00:00Z`);
    if (to) q.set('to', new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString());
    if (search) q.set('search', search);
    return q;
  }, [status, elig, cov, flags, stars, from, to, search]);

  const load = useCallback(async () => {
    const q = new URLSearchParams(filters);
    q.set('sort', sort);
    q.set('dir', dir);
    q.set('limit', String(PAGE));
    q.set('offset', String(page * PAGE));
    try {
      // The unfiltered summary: the nav count (active events) and whether a cutover is set.
      const [sum, list] = await Promise.all([
        api<ObservationSummary>('observations/summary'),
        api<ObservationPage>(`observations?${q}`),
      ]);
      setNavCount('observation', sum.summary.byStatus.ACTIVE?.events ?? 0);
      setData({ sum, list });
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    }
  }, [filters, sort, dir, page, setNavCount]);

  useEffect(() => {
    void load();
  }, [dataVersion, load]);
  useEffect(() => () => clearTimeout(debounce.current), []);

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
    return [
      { label: head('symbol', 'Coin'), render: (r) => <CoinCell r={r} /> },
      { label: head('stars', 'Stars'), render: (r) => <Stars n={r.stars} /> },
      {
        label: head('points', 'Points'),
        num: true,
        title: 'Weighted points at the signal (weighted_star_v1), never updated',
        render: (r) =>
          r.points === null ? '—' : `${r.points}${r.scoreComplete === false ? ' ≥' : ''}`,
      },
      {
        label: head('detected', 'CMC crawl'),
        title:
          'The hourly CMC crawl that found the event (its identity and UTC date); the window starts later, when the signal was usable',
        render: (r) => (
          <span
            title={`crawl ${utc(r.crawlAt)} · CMC quote ${utc(r.cmcQuoteAt)} · CMC price ${r.cmcPriceUsd} USD (context only)`}
          >
            {fmtTime(r.crawlAt)}
          </span>
        ),
      },
      {
        label: head('start', 'Window start'),
        title:
          'When the star signal was proven usable (the Review Queue was published); the window is exactly 168 h from here',
        render: (r) =>
          r.window ? (
            <span
              title={`${utc(r.window.start)} – ${utc(r.window.end)}\nproven by: ${TIMING_TEXT[r.window.source] ?? r.window.source}${r.window.uncertain ? ' (later than the earliest usable moment)' : ''}`}
            >
              {fmtTime(r.window.start)}
              <span className="muted small">{` · ${delayText(r.window.afterCrawlMs)} after crawl`}</span>
            </span>
          ) : (
            <span className="muted">pending</span>
          ),
      },
      {
        label: 'LBank Spot pair',
        render: (r) =>
          r.pair.symbol ? (
            <span
              title={`LBank pair ${MAPPING_TEXT[r.pair.mapping] ?? humanize(r.pair.mapping).toLowerCase()}; quoted in ${r.pair.quote ?? '—'}`}
            >
              {r.pair.symbol.toUpperCase().replace('_', '/')}
            </span>
          ) : (
            <span className="muted">
              {MAPPING_TEXT[r.pair.mapping] ?? humanize(r.pair.mapping).toLowerCase()}
            </span>
          ),
      },
      {
        label: head('referenceDelay', 'Reference'),
        title:
          'Reference price: the first verified LBank Spot trade at or after the window start, and its delay. An observed trade, not an executed order.',
        render: (r) =>
          r.reference.price !== null && r.reference.delayMs !== null ? (
            <span
              title={`trade ${r.reference.tradeId} at ${utc(r.reference.at)} · qty ${r.reference.qty}${r.reference.delayed ? '\ndelayed: a whole minute after the start passed without a trade' : ''}`}
            >
              {fmtPrice(r.reference.price)}
              <span className="muted small">{` · ${delayText(r.reference.delayMs)}`}</span>
              {r.reference.delayed ? <span className="chip warn small">delayed</span> : null}
            </span>
          ) : (
            <span className="muted">
              {r.status === 'NO_TRADES' ? 'no trade' : humanize(r.reference.status).toLowerCase()}
            </span>
          ),
      },
      {
        label: head('highest', 'Highest'),
        num: true,
        title:
          'Maximum rise: 100 × (highest verified trade ÷ reference − 1), never below 0. Not profit. * provisional unless Final.',
        render: (r) => <ExtremeCell r={r} v={r.highest} kind="highest" />,
      },
      {
        label: head('lowest', 'Lowest'),
        num: true,
        title:
          'Maximum decline: 100 × (lowest verified trade ÷ reference − 1), never above 0. Independent of the highest; not a stop loss.',
        render: (r) => <ExtremeCell r={r} v={r.lowest} kind="lowest" />,
      },
      {
        label: 'Status',
        render: (r) => (
          <div className="obs-status">
            <Lab map={STATUS} k={r.status} />
            {r.reasons.length ? (
              <span className="muted small">{r.reasons.map(obsReasonText).join(' · ')}</span>
            ) : null}
          </div>
        ),
      },
      {
        label: head('coverage', 'Coverage'),
        title:
          'Minutes of the window with an LBank candle, gaps by kind, and how fresh the data is (not the last recomputation)',
        render: (r) => (
          <span
            title={[
              `${fmtInt(r.coverage.minutesTraded)} minutes with trades`,
              ...r.coverage.gaps
                .slice(0, 4)
                .map(
                  (g) => `${utc(g.from)}–${utc(g.to)}: ${GAP_TEXT[g.state] ?? humanize(g.state)}`,
                ),
              `data through ${utc(r.freshness.dataThrough)}`,
              `last LBank fetch ${utc(r.freshness.lastSourceFetchAt)}`,
              r.freshness.lastFetchError ? `last error: ${r.freshness.lastFetchError}` : '',
              `recomputed ${utc(r.freshness.lastRecomputedAt)}`,
            ]
              .filter(Boolean)
              .join('\n')}
          >
            {`${fmtInt(r.coverage.minutesPresent)} / ${fmtInt(r.coverage.minutesExpected)}`}
            {r.coverage.gaps.length ? (
              <span className="muted small">{` · ${r.coverage.gaps.length} gap${r.coverage.gaps.length > 1 ? 's' : ''}`}</span>
            ) : null}
            <span className="muted small">{` · data ${fmtAgo(r.freshness.dataThrough)}`}</span>
          </span>
        ),
      },
      {
        label: 'Spot / Futures',
        title:
          'Spot at the signal from LBank’s candles and pair list; Futures = listing evidence from snapshots before and after the signal (never a Futures price)',
        render: (r) => (
          <Lab
            map={ELIGIBILITY}
            k={r.eligibility}
            title={`Spot at the signal: ${LISTING_TEXT[r.spot] ?? humanize(r.spot).toLowerCase()}${r.spotTrading ? ` (${TRADING_TEXT[r.spotTrading] ?? humanize(r.spotTrading).toLowerCase()})` : ''} · Futures: ${FUTURES_TEXT[r.futures] ?? humanize(r.futures).toLowerCase()}`}
          />
        ),
      },
      {
        label: 'Flags',
        title: 'Review flags: kept and shown, never excluded',
        render: (r) =>
          r.flags.length ? (
            <span className="chips">
              {r.flags.map((f) => (
                <span key={f} className="chip warn small" title={FLAG[f]?.[1] ?? humanize(f)}>
                  {FLAG[f]?.[0] ?? humanize(f)}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">—</span>
          ),
      },
      {
        label: 'Overlaps',
        title:
          "The same coin's other observations whose windows overlap this one (correlated: one price path). Click for the list.",
        render: (r) =>
          r.overlapping ? (
            <button
              type="button"
              className="chip link-chip"
              title={`${r.symbol} has ${r.coinEvents} observations; ${r.overlapping} share part of this window. Click for the list.`}
              onClick={() => openObservationOverlaps(r)}
            >
              {`${r.overlapping} overlapping`}
            </button>
          ) : (
            <span className="muted">—</span>
          ),
      },
      {
        label: '',
        title: 'Everything behind this observation: evidence, gaps, flags, history',
        render: (r) => (
          <button
            type="button"
            className="chip link-chip"
            aria-label={`Details of ${r.symbol} ${r.stars} stars`}
            onClick={() => openObservationDetail(r)}
          >
            Details
          </button>
        ),
      },
    ];
  }, [sort, dir, onSort]);

  const empty = data?.sum.cutover.cutoverAt
    ? 'No observation matches these filters.'
    : 'No observation yet: the cutover is not set, so every star event still goes to the legacy forward test.';
  return (
    <>
      <div className="toolbar">
        <SearchField
          label="Filter by coin, CMC id or pair"
          value={searchText}
          onChange={onSearch}
        />
        <Select
          label="Status"
          items={STATUS_FILTERS}
          value={status}
          onPick={(v) => setQuery({ status: v, page: null }, { push: true })}
        />
        <Select
          label="Spot / Futures"
          items={ELIG_FILTERS}
          value={elig}
          onPick={(v) => setQuery({ elig: v, page: null }, { push: true })}
        />
        <Select
          label="Coverage"
          items={COVERAGE_FILTERS}
          value={cov}
          onPick={(v) => setQuery({ cov: v, page: null }, { push: true })}
        />
        <Select
          label="Flags"
          items={FLAG_FILTERS}
          value={flags}
          onPick={(v) => setQuery({ flags: v, page: null }, { push: true })}
          title="Review flags are kept in every count; this only filters the table"
        />
        <label className="select-field" title="UTC date of the CMC crawl (the event's date), from">
          <span>From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setQuery({ from: e.target.value, page: null }, { push: true })}
          />
        </label>
        <label className="select-field" title="UTC date of the CMC crawl, to (inclusive)">
          <span>To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setQuery({ to: e.target.value, page: null }, { push: true })}
          />
        </label>
        <Seg
          label="Stars"
          items={STAR_FILTERS}
          value={stars}
          onPick={(v) => setQuery({ stars: v, page: null }, { push: true })}
        />
      </div>
      {error ? <div className="banner inline">{errorMessage(error)}</div> : null}
      <div className="panel flush">
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

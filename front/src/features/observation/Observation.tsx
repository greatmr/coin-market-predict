// LBank Spot Price Observation (docs/lbank-spot-observation.md): each CMC 1/2/3-star event since the
// cutover, observed on LBank Spot 1-minute candles for exactly t0 + 168 h. Only the table and its
// filters: the summary, export and "Update now" are on the Data page (ObservationInsights), the
// rules behind the help button. Every price is LBank Spot. List state lives in the URL:
//   /lbank-spot?status=FINAL&elig=SPOT_ONLY&stars=3&cov=complete&from=2026-11-26&q=btc&sort=rise&dir=desc&page=2
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
import { fmtInt, fmtPct, fmtPrice, fmtTime, utc } from '../../lib/format';
import { useQueryState } from '../../lib/routes';
import { useApp } from '../../state/app';

import { openObservationOverlaps } from './Overlaps';
import {
  ELIGIBILITY,
  LISTING_TEXT,
  MAPPING_TEXT,
  ORDER,
  STATUS,
  TRADING_TEXT,
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
  ['complete', 'Complete so far'],
  ['partial', 'Missing bars'],
];
const STAR_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ['1', '1★'],
  ['2', '2★'],
  ['3', '3★'],
];
const SORTS: readonly ObsSort[] = [
  'detected',
  'stars',
  'points',
  'rise',
  'drop',
  'entryDelay',
  'coverage',
  'symbol',
];
const SORT_LABEL: Record<ObsSort, string> = {
  detected: 'signal time',
  stars: 'stars',
  points: 'points',
  rise: 'maximum rise',
  drop: 'maximum drop',
  entryDelay: 'entry delay',
  coverage: 'coverage',
  symbol: 'coin',
};

const isIn = (list: readonly (readonly [string, string])[], v: string) =>
  list.some(([k]) => k === v);
const isSort = (v: string): v is ObsSort => (SORTS as readonly string[]).includes(v);
const pctText = (v: string | null | undefined) => (v === null || v === undefined ? '—' : fmtPct(v));
const delayText = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;

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

function ExtremeCell({ v, at }: { v: { price: string; barAt: string } | null; at?: string }) {
  if (!v) return <span className="muted">—</span>;
  return (
    <span
      title={`LBank Spot ${fmtPrice(v.price)} in the 1-minute bar opening ${utc(v.barAt)}${at ? ` (${at})` : ''}`}
    >
      {fmtPrice(v.price)}
      <span className="muted small">{` · ${fmtTime(v.barAt)}`}</span>
    </span>
  );
}

export default function Observation() {
  const { openCoin, dataVersion, setNavCount } = useApp();
  const [query, setQuery] = useQueryState({
    status: '',
    elig: '',
    cov: '',
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
    if (stars) q.set('stars', stars);
    // UTC calendar dates of the CMC signal time ([from 00:00, to + 1 day 00:00)).
    if (from) q.set('from', `${from}T00:00:00Z`);
    if (to) q.set('to', new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString());
    if (search) q.set('search', search);
    return q;
  }, [status, elig, cov, stars, from, to, search]);

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
        label: head('detected', 'CMC signal (t0)'),
        title:
          'The CMC star event time (the batch crawl time); the window ends exactly 168 h later',
        render: (r) => (
          <span
            title={`${utc(r.signalAt)} · window ends ${utc(r.windowEnd)} · CMC price ${r.cmcPriceUsd} USD (context only)`}
          >
            {fmtTime(r.signalAt)}
          </span>
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
        label: 'Spot / Futures',
        title:
          'At the signal, from evidence before and after it; Unknown is never shown as Yes or No',
        render: (r) => (
          <Lab
            map={ELIGIBILITY}
            k={r.eligibility}
            title={`At the signal: Spot ${LISTING_TEXT[r.spot] ?? humanize(r.spot).toLowerCase()}${r.spotTrading ? ` (${TRADING_TEXT[r.spotTrading] ?? humanize(r.spotTrading).toLowerCase()})` : ''} · Futures ${LISTING_TEXT[r.futures] ?? humanize(r.futures).toLowerCase()}`}
          />
        ),
      },
      {
        label: head('entryDelay', 'LBank entry'),
        title:
          'OPEN of the first 1-minute LBank Spot bar opening at or after t0, and its delay after t0',
        render: (r) =>
          r.entry ? (
            <span
              title={`bar ${utc(r.entry.at)}; last trade before it in the bar of ${r.entry.lastTradeAt ? utc(r.entry.lastTradeAt) : 'none within 60 min'}`}
            >
              {fmtPrice(r.entry.price)}
              <span className="muted small">{` · +${delayText(r.entry.delayMs)}${r.entry.stale ? ' · stale' : ''}`}</span>
            </span>
          ) : (
            <span className="muted">—</span>
          ),
      },
      {
        label: head('rise', 'Max rise'),
        num: true,
        title: '100 × (highest LBank Spot High ÷ entry − 1). Not profit. Provisional unless Final.',
        render: (r) => (
          <span className={r.provisional ? 'muted' : undefined}>
            {pctText(r.maxRisePct)}
            {r.provisional && r.maxRisePct !== null ? ' *' : ''}
          </span>
        ),
      },
      {
        label: head('drop', 'Max drop'),
        num: true,
        title:
          '100 × (lowest LBank Spot Low ÷ entry − 1), negative for a decline. Not a tested stop loss.',
        render: (r) => (
          <span className={r.provisional ? 'muted' : undefined}>
            {pctText(r.maxDropPct)}
            {r.provisional && r.maxDropPct !== null ? ' *' : ''}
          </span>
        ),
      },
      {
        label: 'Highest High',
        render: (r) => (
          <ExtremeCell v={r.high} at={r.extremeOrder ? ORDER[r.extremeOrder] : undefined} />
        ),
      },
      {
        label: 'Lowest Low',
        render: (r) => (
          <ExtremeCell v={r.low} at={r.extremeOrder ? ORDER[r.extremeOrder] : undefined} />
        ),
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
          '1-minute bars present of those expected so far; the minute straddling t0 + 168 h is never counted',
        render: (r) => (
          <span
            title={[
              `${fmtInt(r.coverage.tradedBars)} bars with trades`,
              r.coverage.missingBars
                ? `missing ${fmtInt(r.coverage.missingBars)}: ${r.coverage.missingRanges
                    .slice(0, 3)
                    .map(([a, b]) => `${utc(a)}–${utc(b)}`)
                    .join(', ')}`
                : '',
              `unobserved: ${delayText(r.coverage.startUnobservedMs)} after t0, ${delayText(r.coverage.boundaryUnobservedMs)} before the cutoff`,
              r.lastUpdateAt ? `updated ${utc(r.lastUpdateAt)}` : '',
            ]
              .filter(Boolean)
              .join('\n')}
          >
            {`${fmtInt(r.coverage.coveredBars)} / ${fmtInt(r.coverage.expectedBars)}`}
            {r.coverage.missingBars ? (
              <span className="muted small">{` · ${fmtInt(r.coverage.missingBars)} missing`}</span>
            ) : null}
          </span>
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
        <label className="select-field" title="UTC date of the CMC signal, from">
          <span>From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setQuery({ from: e.target.value, page: null }, { push: true })}
          />
        </label>
        <label className="select-field" title="UTC date of the CMC signal, to (inclusive)">
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

// Star Event Forward Test events: only the table with its filters, each coin's Average Return and
// exchange listings (docs/adr/0007-exchange-listings.md). The summary, results by stars, rejected
// triggers and High-check controls live on the Data page (ForwardInsights). List state lives in
// the URL:
//   /forward?view=tracking&stars=3&result=CONFIRMED&market=both&bithumb=listed&sort=coinAverage&dir=desc&q=btc&page=2
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SearchField } from '../../components/icons';
import {
  CoinCell,
  type Column,
  Lab,
  LoadError,
  Pager,
  PointsCell,
  SkeletonTable,
  Stars,
  Table,
} from '../../components/ui';
import { api } from '../../lib/api';
import { fmtAgo, fmtInt, fmtPrice, fmtTime, utc } from '../../lib/format';
import { useQueryState } from '../../lib/routes';
import { useApp } from '../../state/app';

import {
  BithumbCell,
  CheckCell,
  CoinAverageCell,
  FwdPeak,
  FwdReturn,
  FwdWindows,
  LbankMarketsCell,
  NotesCell,
  SortHead,
  WindowCell,
} from './cells';
import {
  BITHUMB_FILTERS,
  FWD_STATUS,
  MARKET_FILTERS,
  RESULT_FILTERS,
  STATUS_FILTERS,
} from './labels';
import type {
  EventSort,
  ExchangeListStatus,
  ForwardEventRow,
  ForwardEventsPage,
  ForwardSummary,
} from './types';

const FWD_PAGE = 100;
const STAR_FILTERS: readonly (readonly [string, string])[] = [
  ['', 'All'],
  ['1', '1★'],
  ['2', '2★'],
  ['3', '3★'],
];
const SORTS: readonly EventSort[] = [
  'detected',
  'return',
  'coinAverage',
  'stars',
  'points',
  'multiple3d',
  'multiple7d',
  'multiple30d',
];

const isStars = (v: string) => STAR_FILTERS.some(([k]) => k === v);
const statusFilter = (v: string) => STATUS_FILTERS.find(([k]) => k === v) ?? STATUS_FILTERS[0]!;
const isResult = (v: string) => RESULT_FILTERS.some(([k]) => k === v);
const isMarket = (v: string) => MARKET_FILTERS.some(([k]) => k === v);
const isBithumb = (v: string) => BITHUMB_FILTERS.some(([k]) => k === v);
const isSort = (v: string): v is EventSort => (SORTS as readonly string[]).includes(v);

const LIST_STATE: Record<Exclude<ExchangeListStatus['status'], 'VERIFIED'>, string> = {
  STALE: 'list too old, Unknown until it is fetched again',
  INCOMPLETE: 'last fetch incomplete, Unknown',
  FAILED: 'last fetch failed, Unknown',
  NOT_FETCHED: 'not fetched yet, Unknown until the next hourly run',
  UNSUPPORTED: 'not available from this data source, Unknown',
};

/** Which exchange lists the LBank and Bithumb columns come from, and how fresh each one is. */
function ListsLine({ lists }: { lists: ExchangeListStatus[] }) {
  return (
    <p className="muted small fwd-lists">
      {'Listings come from: '}
      {lists.map((l, i) => {
        const title = [
          l.fetchedAt
            ? `Fetched ${fmtTime(l.fetchedAt)} (${utc(l.fetchedAt)}), ${fmtInt(l.pairs)} pairs.`
            : '',
          l.staleAt ? `Counts until ${fmtTime(l.staleAt)}.` : '',
          l.lastAttempt
            ? `Last attempt ${fmtTime(l.lastAttempt.at)}: ${l.lastAttempt.status}${l.lastAttempt.error ? ` (${l.lastAttempt.error})` : ''}.`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        return (
          <span key={l.key} title={title || undefined}>
            {i ? ' · ' : ''}
            {l.status === 'VERIFIED'
              ? `${l.label} list fetched ${fmtAgo(l.fetchedAt)}`
              : `${l.label}: ${LIST_STATE[l.status]}`}
          </span>
        );
      })}
      {'.'}
    </p>
  );
}

function Seg({
  label,
  items,
  value,
  onPick,
  attr,
}: {
  label: string;
  items: readonly (readonly [string, string])[];
  value: string;
  onPick: (v: string) => void;
  attr: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map(([v, text]) => (
        <button
          key={v}
          type="button"
          {...{ [`data-${attr}`]: v }}
          aria-pressed={value === v}
          onClick={() => onPick(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

interface ForwardData {
  sum: ForwardSummary;
  ev: ForwardEventsPage;
  search: string;
  filtered: boolean;
}

export default function Forward() {
  const { openCoin, dataVersion, setNavCount } = useApp();
  const [query, setQuery] = useQueryState({
    view: 'active',
    stars: '',
    result: '',
    market: '',
    bithumb: '',
    sort: 'detected',
    dir: 'desc',
    q: '',
    page: '1',
  });
  const [statusKey, , statusApi] = statusFilter(query.view);
  const stars = isStars(query.stars) ? query.stars : '';
  const result = isResult(query.result) ? query.result : '';
  const market = isMarket(query.market) ? query.market : '';
  const bithumb = isBithumb(query.bithumb) ? query.bithumb : '';
  const sort: EventSort = isSort(query.sort) ? query.sort : 'detected';
  const dir = query.dir === 'asc' ? 'asc' : 'desc';
  const search = query.q.trim();
  const pageNum = Number(query.page);
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum - 1 : 0;

  const [searchText, setSearchText] = useState(query.q);
  const [data, setData] = useState<ForwardData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keep the box in step when the URL changes from outside (back button, a shared link).
  useEffect(() => {
    setSearchText((t) => (t.trim() === query.q.trim() ? t : query.q));
  }, [query.q]);

  const load = useCallback(async () => {
    const q = new URLSearchParams({
      view: statusApi.view,
      sort,
      dir,
      limit: String(FWD_PAGE),
      offset: String(page * FWD_PAGE),
    });
    if (statusApi.status) q.set('status', statusApi.status);
    if (stars) q.set('stars', stars);
    if (result) q.set('result', result);
    if (market) q.set('market', market);
    if (bithumb) q.set('bithumb', bithumb);
    if (search) q.set('search', search);
    try {
      const [sum, ev] = await Promise.all([
        api<ForwardSummary>('forward'),
        api<ForwardEventsPage>(`forward/events?${q}`),
      ]);
      const by = sum.counts.byStatus;
      setNavCount('forward', (by.OPEN ?? 0) + (by.TRACKING ?? 0) + (by.AWAITING_FINAL_DAY ?? 0));
      setData({
        sum,
        ev,
        search,
        filtered: statusKey !== 'active' || !!stars || !!result || !!market || !!bithumb,
      });
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    }
  }, [statusApi, statusKey, stars, result, market, bithumb, sort, dir, search, page, setNavCount]);

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

  // Each header cycles highest first → lowest first → off (the default: newest identification first).
  const onSort = useCallback(
    (k: EventSort) =>
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

  const cols = useMemo<Column<ForwardEventRow>[]>(() => {
    const head = (k: EventSort, label: string) => (
      <SortHead k={k} label={label} sort={sort} dir={dir} onSort={onSort} />
    );
    return [
      { label: 'Coin', render: (r) => <CoinCell r={r} /> },
      { label: head('stars', 'Stars'), render: (r) => <Stars n={r.starCount} /> },
      {
        label: head('points', 'Points'),
        num: true,
        title: 'Weighted points at identification (weighted_star_v1); never updated',
        render: (r) => (
          <PointsCell
            points={r.weightedPassPoints}
            complete={r.scoreComplete}
            strength={r.weightedStrength}
          />
        ),
      },
      {
        label: head('detected', 'Identified'),
        render: (r) => (
          <span title={`${utc(r.detectedAt)} (UTC date ${r.detectedUtcDate}, day 0)`}>
            {fmtTime(r.detectedAt)}
          </span>
        ),
      },
      {
        label: 'Price',
        num: true,
        title:
          'CMC USD price recorded at identification: fixed for the event, a reference, not a fill',
        render: (r) => fmtPrice(r.referencePriceUsd),
      },
      { label: 'Highest High', render: (r) => <FwdPeak r={r} /> },
      { label: head('return', 'Return'), num: true, render: (r) => <FwdReturn r={r} /> },
      {
        label: head('coinAverage', 'Average Return (coin)'),
        num: true,
        title:
          'Mean of the Returns of every stored event of this coin (CMC id), whatever the filters; events without a Return left out, ≥ while any is a lower bound. A peak return, not profit.',
        render: (r) => <CoinAverageCell r={r} />,
      },
      { label: 'Status', render: (r) => <Lab map={FWD_STATUS} k={r.status} /> },
      {
        label: 'High check',
        title: 'Result of the last check, the UTC date it is checked through and when it ran',
        render: (r) => <CheckCell r={r} />,
      },
      {
        label: 'Window (UTC days)',
        title: 'Day 0 = UTC date of identification … day 7 = UTC date of identification + 168 h',
        render: (r) => <WindowCell r={r} />,
      },
      {
        label: (
          <span className="sort-group" title="Ratios at identification (current VMC ÷ mean)">
            {head('multiple3d', '3d')}
            {head('multiple7d', '7d')}
            {head('multiple30d', '30d')}
          </span>
        ),
        render: (r) => <FwdWindows r={r} />,
      },
      {
        label: 'LBank',
        title:
          "Listed now in LBank's Spot and in LBank's Futures markets, each checked in its own list by CMC id; Unknown = that list is not verified",
        render: (r) => <LbankMarketsCell r={r} />,
      },
      {
        label: 'Bithumb',
        title:
          "Listed now in Bithumb's Spot markets (by CMC id); Unknown = the list is not verified",
        render: (r) => <BithumbCell r={r} />,
      },
      { label: 'Notes', render: (r) => <NotesCell r={r} /> },
    ];
  }, [sort, dir, onSort]);

  const s = data?.sum;
  const eventsEmpty = data?.search
    ? `No event matches “${data.search}”.`
    : data?.filtered
      ? 'No events match these filters.'
      : 'No active event. Eligible 1, 2 and 3-star coins of a published queue are recorded automatically.';

  return (
    <>
      <div className="toolbar">
        <SearchField label="Filter events" value={searchText} onChange={onSearch} />
        <label className="select-field">
          <span>Status</span>
          <select
            value={statusKey}
            onChange={(e) => setQuery({ view: e.target.value, page: null }, { push: true })}
          >
            {STATUS_FILTERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="select-field">
          <span>Result</span>
          <select
            value={result}
            onChange={(e) => setQuery({ result: e.target.value, page: null }, { push: true })}
          >
            {RESULT_FILTERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="select-field"
          title="The coin's listing on LBank now: Spot, Futures or both"
        >
          <span>LBank</span>
          <select
            value={market}
            onChange={(e) => setQuery({ market: e.target.value, page: null }, { push: true })}
          >
            {MARKET_FILTERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="select-field" title="The coin's listing on Bithumb now">
          <span>Bithumb</span>
          <select
            value={bithumb}
            onChange={(e) => setQuery({ bithumb: e.target.value, page: null }, { push: true })}
          >
            {BITHUMB_FILTERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Seg
          label="Stars"
          attr="stars"
          items={STAR_FILTERS}
          value={stars}
          onPick={(v) => setQuery({ stars: v, page: null }, { push: true })}
        />
      </div>
      {s?.exchangeLists?.length ? <ListsLine lists={s.exchangeLists} /> : null}
      <div className="panel flush">
        <div className="table-wrap">
          {error ? (
            <LoadError error={error} />
          ) : data ? (
            <Table
              cols={cols}
              rows={data.ev.rows}
              empty={eventsEmpty}
              onRow={(r) => openCoin(r.cmcId)}
              rowKey={(r, i) => r.eventId || i}
            />
          ) : (
            <SkeletonTable rows={12} label="Loading events…" />
          )}
        </div>
      </div>
      <div className="pager">
        {data ? (
          <Pager
            page={page}
            pageSize={FWD_PAGE}
            total={data.ev.total}
            unit="events"
            onPage={(p) => setQuery({ page: p > 0 ? p + 1 : null }, { push: true })}
          />
        ) : null}
      </div>
    </>
  );
}

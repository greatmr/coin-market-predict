// LBank Spot Price Observation (docs/lbank-spot-observation.md): each CMC 1/2/3-star event since the
// cutover, observed on LBank Spot 1-minute candles for exactly t0 + 168 h. Every price on this page
// is LBank Spot; the CMC price is labelled context. List state lives in the URL:
//   /lbank-spot?status=FINAL&elig=SPOT_ONLY&stars=3&cov=complete&from=2026-11-26&q=btc&sort=rise&dir=desc&page=2
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SearchField } from '../../components/icons';
import {
  CoinCell,
  type Column,
  Kv,
  Lab,
  LoadError,
  Pager,
  SkeletonTable,
  Stars,
  Table,
} from '../../components/ui';
import { api, apiPost, errorMessage } from '../../lib/api';
import { apiUrl } from '../../lib/config';
import type { StatusMap } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtInt, fmtPct, fmtPrice, fmtTime, utc } from '../../lib/format';
import { useQueryState } from '../../lib/routes';
import { useApp } from '../../state/app';

import type {
  LegacyStatus,
  ObsSort,
  ObservationPage,
  ObservationRow,
  ObservationSummary,
  StatsJson,
} from './types';

const PAGE = 100;

const STATUS: StatusMap = {
  ACTIVE: ['accent', 'Active'],
  FINAL: ['good', 'Final'],
  PARTIAL: ['warning', 'Partial'],
  DATA_UNAVAILABLE: ['serious', 'Data unavailable'],
  MAPPING_AMBIGUOUS: ['serious', 'Mapping ambiguous'],
  ELIGIBILITY_UNKNOWN: ['warning', 'Eligibility unknown'],
};

const ELIGIBILITY: StatusMap = {
  PENDING: ['', 'Pending'],
  SPOT_AND_FUTURES: ['good', 'Spot + Futures eligible'],
  SPOT_ONLY: ['accent', 'Spot only'],
  SPOT_FUTURES_UNKNOWN: ['', 'Spot available / Futures unknown'],
  SPOT_UNAVAILABLE: ['serious', 'Spot unavailable'],
  SPOT_UNKNOWN: ['warning', 'Spot unknown'],
  MAPPING_AMBIGUOUS: ['serious', 'Mapping ambiguous'],
};

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

const REASON: Record<string, string> = {
  MAPPING_PENDING: 'mapping not decided yet',
  NO_USDT_PAIR: 'no LBank USDT pair for this CMC id',
  MULTIPLE_USDT_PAIRS: 'several LBank USDT pairs: ambiguous',
  PAIR_SYMBOL_UNVERIFIED: 'LBank symbol not verifiable from CMC',
  PRICE_DEVIATION_FROM_CMC: 'LBank entry deviates > 25 % from CMC: identity uncertain',
  PAIR_UNSUPPORTED_BY_API: 'LBank: currency pair not supported (delisted or unknown)',
  SPOT_NOT_LISTED_AT_SIGNAL: "not in LBank's Spot list at the signal",
  SPOT_EVIDENCE_MISSING: 'no Spot evidence near the signal',
  SPOT_EVIDENCE_CONFLICT: 'Spot evidence conflicts',
  ENTRY_PENDING: 'entry bar not fetched yet',
  ENTRY_UNAVAILABLE: 'no LBank bar after the signal',
  ENTRY_TOO_LATE: 'first bar more than 2 min after the signal',
  ENTRY_STALE: 'no trade in the hour before entry: stale reference',
  WINDOW_OPEN: 'window open (provisional)',
  FETCH_PENDING: 'last bars not fetched yet',
  FETCH_INCOMPLETE: 'window not fully fetched',
  FETCH_ERROR: 'last LBank request failed',
  MISSING_BARS: 'missing 1-minute bars',
  NO_TRADES_IN_WINDOW: 'no trade in the window',
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

const STATUS_RUN: StatusMap = {
  running: ['accent', 'Running'],
  succeeded: ['good', 'Succeeded'],
  partial: ['warning', 'Partial'],
  failed: ['critical', 'Failed'],
};

const statsLine = (s: StatsJson) =>
  s.n
    ? `median ${pctText(s.median)} · mean ${pctText(s.mean)} · p25 ${pctText(s.p25)} · p75 ${pctText(s.p75)} · min ${pctText(s.min)} · max ${pctText(s.max)}`
    : 'no final observation yet';

function SummaryPanel({ s, legacy }: { s: ObservationSummary; legacy: LegacyStatus | null }) {
  const f = s.summary.final;
  const c = s.summary.correlation;
  return (
    <div className="panel">
      <p className="muted small">
        {`Prices: ${s.priceSource}. Window: exactly ${s.windowHours} h from the CMC signal time. Entry: OPEN of the first 1-minute bar at or after the signal (at most ${s.maxEntryDelayMs / 60_000} min later; stale without a trade in the ${s.maxEntryStalenessMs / 60_000} min before). CMC prices are context only. Rules ${s.rulesVersion}.`}
      </p>
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Cutover (UTC)</span>
          <b>{s.cutover.cutoverAt ? utc(s.cutover.cutoverAt) : 'Not set'}</b>
          <span className="muted small">
            {s.cutover.cutoverAt
              ? s.cutover.passed
                ? 'New star events come here; the legacy forward test takes none'
                : 'Not reached yet: new events still go to the legacy forward test'
              : 'Set with npm run cli -- observation:cutover'}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Observations</span>
          <b>{`${fmtInt(s.summary.total.events)} events`}</b>
          <span className="muted small">{`on ${fmtInt(s.summary.total.coins)} coins (overlapping events of one coin are correlated)`}</span>
        </div>
        <div className="tile" title="Statistics below use FINAL observations only">
          <span className="tile-label">Final (the denominator)</span>
          <b>{`${fmtInt(f.events)} events · ${fmtInt(f.coins)} coins`}</b>
          <span className="muted small">{`provisional (active / partial): ${fmtInt(s.summary.provisional.events)} · no measurement: ${fmtInt(s.summary.unmeasured.events)}`}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Last update</span>
          <b>{s.lastRun ? <Lab map={STATUS_RUN} k={s.lastRun.status} /> : 'Not yet'}</b>
          <span className="muted small">
            {s.lastRun
              ? `${fmtAgo(s.lastRun.startedAt)} (${s.lastRun.trigger})`
              : 'the job runs every 15 minutes'}
            {s.lastSuccessfulRunAt ? ` · last successful ${fmtAgo(s.lastSuccessfulRunAt)}` : ''}
          </span>
        </div>
      </div>
      <Kv
        pairs={[
          [`Maximum rise, final (n = ${fmtInt(f.rise.n)} events)`, statsLine(f.rise)],
          [`Maximum drop, final (n = ${fmtInt(f.drop.n)} events)`, statsLine(f.drop)],
          ...f.byStars
            .filter((g) => g.events)
            .map(
              (g) =>
                [
                  `${g.key}★ final: ${fmtInt(g.events)} events, ${fmtInt(g.coins)} coins`,
                  `rise median ${pctText(g.rise.median)} · drop median ${pctText(g.drop.median)}`,
                ] as const,
            ),
          [
            'Correlation',
            `${fmtInt(c.coinsWithSeveralEvents)} coins have several events (${fmtInt(c.eventsOfThoseCoins)} events); ${fmtInt(c.overlappingPairs)} pairs of one coin's events overlap in time`,
          ],
        ]}
      />
      <p className="muted small">
        Maximum rise and maximum drop are two independent price extremes over the window: not a
        profit, not a tested stop loss, and not a Futures or leveraged result. The Futures label is
        an eligibility indicator only.
      </p>
      {legacy && legacy.state !== 'active' ? (
        <p className="muted small">
          {legacy.state === 'retired'
            ? `Legacy forward test retired: ${fmtInt(legacy.events)} events — final ${fmtInt(legacy.closures.FINAL)}, incomplete ${fmtInt(legacy.closures.INCOMPLETE)}, data unavailable ${fmtInt(legacy.closures.DATA_UNAVAILABLE)}.`
            : `Legacy forward test winding down: ${fmtInt(legacy.pending)} of ${fmtInt(legacy.events)} pre-cutover events still pending${legacy.pendingUntil ? ` (terminal by ${fmtTime(legacy.pendingUntil)})` : ''}.`}
        </p>
      ) : null}
    </div>
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

const ORDER: Record<string, string> = {
  HIGH_FIRST: 'High first',
  LOW_FIRST: 'Low first',
  SAME_BAR: 'Same minute: order unknown',
};

export default function Observation() {
  const { openCoin, dataVersion, setNavCount, can } = useApp();
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
  const [legacy, setLegacy] = useState<LegacyStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
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
      const [sum, list, leg] = await Promise.all([
        api<ObservationSummary>(`observations/summary?${filters}`),
        api<ObservationPage>(`observations?${q}`),
        api<LegacyStatus>('forward/legacy').catch(() => null),
      ]);
      setNavCount('observation', sum.summary.byStatus.ACTIVE?.events ?? 0);
      setData({ sum, list });
      setLegacy(leg);
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

  const runNow = async () => {
    setStarting(true);
    try {
      const r = await apiPost<{ ok: boolean; reason?: string }>('observations/update');
      if (r.ok)
        toast('The LBank observation update started; the page refreshes with the next poll.');
      else toast(`The update did not start: ${r.reason ?? 'unknown reason'}`, 'warning');
    } catch (err) {
      toast(`The update did not start: ${errorMessage(err)}`, 'error');
    } finally {
      setStarting(false);
    }
  };

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
            <span title={`mapping ${r.pair.mapping}; quote ${r.pair.quote ?? '—'}`}>
              {r.pair.symbol.toUpperCase().replace('_', '/')}
            </span>
          ) : (
            <span className="muted">
              {r.pair.mapping === 'NONE' ? 'none' : r.pair.mapping.toLowerCase()}
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
            title={`Spot ${r.spot}${r.spotTrading ? ` (${r.spotTrading.toLowerCase().replace(/_/g, ' ')})` : ''} · Futures ${r.futures}`}
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
          <Lab
            map={STATUS}
            k={r.status}
            title={r.reasons.map((x) => REASON[x.split(':')[0]!] ?? x).join(' · ') || undefined}
          />
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
        label: 'Same coin',
        num: true,
        title: "This coin's observations, and how many of them overlap this window (correlated)",
        render: (r) => (r.coinEvents > 1 ? `${r.coinEvents} (${r.overlapping} overlap)` : '1'),
      },
    ];
  }, [sort, dir, onSort]);

  const empty = data?.sum.cutover.cutoverAt
    ? 'No observation matches these filters.'
    : 'No observation yet: the cutover is not set, so every star event still goes to the legacy forward test.';
  const exportHref = apiUrl(
    `observations/export.csv?${new URLSearchParams([...filters.entries(), ['sort', sort], ['dir', dir]])}`,
  );

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
        <span className="row-actions">
          {can('exports:read') ? (
            <a className="chip link-chip" href={exportHref} download>
              Export CSV
            </a>
          ) : null}
          {can('scan:operate') ? (
            <button type="button" className="btn" disabled={starting} onClick={() => void runNow()}>
              {starting ? 'Starting…' : 'Update now'}
            </button>
          ) : null}
        </span>
      </div>
      {error ? <div className="banner inline">{errorMessage(error)}</div> : null}
      {data ? <SummaryPanel s={data.sum} legacy={legacy} /> : null}
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
      <p className="muted small">
        * provisional: the window is open or coverage is incomplete; such values never enter the
        final statistics. Every price on this page is LBank Spot (1-minute OHLC); a High and a Low
        in the same minute have an unknown order.
      </p>
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

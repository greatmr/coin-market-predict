// The Review Queue, the only per-coin list stored since D4 (ADR-0008): table or scatter view,
// debounced search, page size and paging. All list state is in the URL (?q, page, rows, view), so a
// view can be shared, reloaded or reached with the back button; it reloads when the URL changes and
// when the latest scanned batch changes. Coins outside the queue are counted on Data and open one
// at a time on their coin page (evaluated on request).
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

import { ChartBox } from '../../components/charts';
import { SearchField } from '../../components/icons';
import {
  Chip,
  CoinCell,
  type Column,
  Lab,
  LoadError,
  Pager,
  PassCell,
  PointsCell,
  SkeletonBlock,
  SkeletonTable,
  Stars,
  Table,
} from '../../components/ui';
import { api } from '../../lib/api';
import { CURRENT, LBANK, QUEUE, reasonText } from '../../lib/constants';
import { fmtTime, fmtUsd, fmtVmc, shortId } from '../../lib/format';
import { useQueryState } from '../../lib/routes';
import { useApp } from '../../state/app';

import ScatterChart from './ScatterChart';
import type { SheetPage, SheetRow } from './types';

const ROW_SIZES = [50, 100, 250] as const;
const DEFAULTS = { q: '', page: '1', rows: '100', view: 'table' };

const pointsCol: Column<SheetRow> = {
  label: 'Points',
  num: true,
  title:
    'Weighted points: 3d 60, 7d 25, 30d 15 per YES. The queue is ranked by stars, then points.',
  render: (r) => (
    <PointsCell
      points={r.weightedPassPoints}
      complete={r.scoreComplete}
      strength={r.weightedStrength}
    />
  ),
};

const COLS: Column<SheetRow>[] = [
  { label: '#', num: true, render: (r: SheetRow) => r.queueOrder },
  { label: 'Coin', render: (r: SheetRow) => <CoinCell r={r} /> },
  // Stars and weighted points are the ranking: show them first.
  { label: 'Stars', render: (r: SheetRow) => <Stars n={r.stars} /> },
  pointsCol,
  { label: 'Rank', num: true, render: (r: SheetRow) => r.rank ?? '—' },
  { label: 'Market cap', num: true, render: (r: SheetRow) => fmtUsd(r.capUsd) },
  {
    label: 'Vol 24h',
    num: true,
    title: 'rolling 24h volume (not this hour)',
    render: (r: SheetRow) => fmtUsd(r.volume24hUsd),
  },
  {
    label: 'Current VMC',
    num: true,
    title: 'rolling 24h volume ÷ market cap',
    render: (r: SheetRow) => (
      <span
        title={r.currentStatus !== 'OK' ? reasonText(r.currentReason) : undefined}
        className={r.currentStatus !== 'OK' ? 'muted' : 'vmc-now'}
      >
        {fmtVmc(r.currentVmc)}
        {r.currentStatus !== 'OK'
          ? ` ${(CURRENT[r.currentStatus]?.[1] ?? r.currentStatus).toLowerCase()}`
          : ''}
      </span>
    ),
  },
  {
    label: '3d',
    render: (r: SheetRow) => (
      <PassCell status={r.pass3d} multiple={r.multiple3d} reason={r.reason3d} />
    ),
  },
  {
    label: '7d',
    render: (r: SheetRow) => (
      <PassCell status={r.pass7d} multiple={r.multiple7d} reason={r.reason7d} />
    ),
  },
  {
    label: '30d',
    render: (r: SheetRow) => (
      <PassCell status={r.pass30d} multiple={r.multiple30d} reason={r.reason30d} />
    ),
  },
  {
    label: '14d mean',
    num: true,
    title: 'context only',
    render: (r: SheetRow) =>
      r.vmc14dAvg === null ? (
        <span className="muted" title={reasonText(r.avg14dReason)}>
          N/A
        </span>
      ) : (
        fmtVmc(r.vmc14dAvg)
      ),
  },
  {
    label: 'LBank',
    render: (r: SheetRow) => (
      <span title={(r.lbankPairs || []).map((p) => p.marketPair).join(', ')}>
        <Lab map={LBANK} k={r.lbankStatus} />
      </span>
    ),
  },
  {
    label: 'Venue',
    render: (r: SheetRow) => (
      <span className="chips">
        {(r.venueFlags || []).map((f) => (
          <Chip key={f}>{f.replace(/_/g, ' ').toLowerCase()}</Chip>
        ))}
      </span>
    ),
  },
  {
    label: 'Review',
    render: (r: SheetRow) =>
      r.review ? (
        <Chip
          tone="violet"
          title={`${r.review.reviewer}, ${fmtTime(r.review.reviewedAt)}; venue ${r.review.venueDecision}; day ${r.review.eventDay}`}
        >
          {`${r.review.finalDecision}${r.review.planStatus ? ` (${r.review.planStatus})` : ''}`}
        </Chip>
      ) : (
        <span className="muted">—</span>
      ),
  },
];

export default function Sheet() {
  const { dataVersion, openCoin, setPageNote } = useApp();
  const [qs, setQs] = useQueryState(DEFAULTS);

  // URL values, validated (anything unexpected falls back to the default).
  const search = qs.q.trim();
  const rowsN = Number(qs.rows);
  const size: number = (ROW_SIZES as readonly number[]).includes(rowsN) ? rowsN : 100;
  const pageN = Number(qs.page);
  const page = Number.isInteger(pageN) && pageN >= 1 ? pageN - 1 : 0;
  const view = qs.view === 'scatter' ? 'scatter' : 'table';

  const [input, setInput] = useState(qs.q);
  const [data, setData] = useState<SheetPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Back / forward or a shared link can change ?q: show it in the field.
  useEffect(() => {
    setInput((cur) => (cur.trim() === qs.q.trim() ? cur : qs.q));
  }, [qs.q]);

  useEffect(() => {
    const mine = ++seq.current;
    const q = new URLSearchParams({
      sheet: 'queue',
      limit: String(size),
      offset: String(page * size),
    });
    if (search) q.set('search', search);
    api<SheetPage>(`scan?${q}`)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
        setPageNote(
          'queue',
          d.batchId ? `Batch ${shortId(d.batchId)}, as of ${fmtTime(d.asOf)}.` : '',
        );
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        console.error(e);
        setError(e);
      });
  }, [dataVersion, search, size, page, setPageNote]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onSearch = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setInput(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setQs({ q: v.trim(), page: null }), 250);
  };

  const open = (r: SheetRow) => openCoin(r.cmcId, data?.batchId ?? null);
  const queueStatus = data?.queueStatus;

  return (
    <>
      <div className="sheet-status">
        {queueStatus && queueStatus !== 'PUBLISHED' && queueStatus !== 'EMPTY' ? (
          <div className="banner inline">
            {`${QUEUE[queueStatus]?.[1] ?? queueStatus}. These rows are shown for inspection only and are not a complete queue.`}
          </div>
        ) : null}
      </div>
      <div className="toolbar">
        <SearchField
          className="sheet-search"
          label="Filter this list"
          value={input}
          onChange={onSearch}
        />
        <div className="seg view-seg" role="group" aria-label="View">
          {(
            [
              ['table', 'Table'],
              ['scatter', 'Scatter'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              data-view={k}
              aria-pressed={view === k}
              onClick={() => setQs({ view: k }, { push: true })}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="rows">
          Rows{' '}
          <select
            className="sheet-rows"
            value={size}
            onChange={(e) => setQs({ rows: e.target.value, page: null })}
          >
            {ROW_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="panel flush">
        <div className="table-wrap sheet-table" hidden={view !== 'table'}>
          {error ? (
            <LoadError error={error} />
          ) : data ? (
            <Table
              cols={COLS}
              rows={data.rows}
              rowKey={(r) => r.cmcId}
              empty={
                !data.batchId
                  ? 'No scan yet.'
                  : search
                    ? `No queued coin matches “${search}”. Search any coin with the search box at the top.`
                    : 'No eligible coin has a current VMC at least 1.5× any of its own 3, 7 or 30-day means.'
              }
              onRow={open}
            />
          ) : (
            <SkeletonTable rows={12} />
          )}
        </div>
        <div className="sheet-scatter" hidden={view !== 'scatter'}>
          {data ? (
            <>
              <p className="muted small scatter-note">
                Each dot is a coin on this page: further above the amber line means a bigger surge
                against its own 30-day mean. Dot size is market cap; colour is stars.
              </p>
              {view === 'scatter' ? (
                <ChartBox>{(W) => <ScatterChart W={W} rows={data.rows} onPick={open} />}</ChartBox>
              ) : (
                <div className="chart-box" />
              )}
            </>
          ) : (
            <SkeletonBlock height={420} />
          )}
        </div>
      </div>
      <div className="pager sheet-pager">
        {data ? (
          <Pager
            page={page}
            pageSize={size}
            total={data.total}
            onPage={(p) => setQs({ page: p + 1 === 1 ? null : p + 1 }, { push: true })}
          />
        ) : null}
      </div>
    </>
  );
}

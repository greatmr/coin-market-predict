// Database storage on the Data page: the size on disk, the share of each area and the largest
// tables, from PostgreSQL's own catalog sizes (GET /api/storage, health:read).
import { useCallback, useEffect, useState } from 'react';

import { HelpButton } from '../../components/Help';
import { HBars } from '../../components/charts';
import { type Column, LoadError, SkeletonBlock, Table } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtAgo, fmtBytes, fmtInt } from '../../lib/format';
import { useApp } from '../../state/app';

import type { StorageReport } from '../observation/types';

type TableRow = StorageReport['tables'][number];

/** Which part of the platform a table belongs to; the first matching prefix wins. */
const AREAS: readonly (readonly [prefix: string, area: string])[] = [
  ['lbank_spot_candle', 'LBank 1-minute candles'],
  ['lbank_', 'LBank observation'],
  ['market_snapshot', 'Hourly snapshots'],
  ['scan_', 'Review queue and scans'],
  ['daily_', 'Daily rows'],
  ['forward_', 'Forward test'],
  ['signal_cutover', 'LBank observation'],
  ['venue', 'Venues and LBank list'],
  ['agent_', 'Claude agent'],
  ['review', 'Reviews'],
  ['telegram', 'Telegram'],
  ['cmc_', 'Coin registry'],
  ['asset', 'Coin registry'],
  ['crawl_batch', 'Hourly crawls'],
  ['discovery_run', 'Hourly crawls'],
  ['pipeline_', 'Pipeline runs'],
  ['app_user', 'Users and sessions'],
  ['user_session', 'Users and sessions'],
];
const areaOf = (t: string) => AREAS.find(([p]) => t.startsWith(p))?.[1] ?? 'Other';

const TOP = 12;

export default function StoragePanel() {
  const { dataVersion } = useApp();
  const [r, setR] = useState<StorageReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setR(await api<StorageReport>('storage'));
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [dataVersion, load]);

  const total = r?.databaseBytes ?? 0;
  const share = (b: number) => (total ? `${((b / total) * 100).toFixed(1)} %` : '—');
  const areas = new Map<string, number>();
  for (const t of r?.tables ?? [])
    areas.set(areaOf(t.name), (areas.get(areaOf(t.name)) ?? 0) + t.totalBytes);
  const bars = [...areas.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({
      label,
      value,
      title: `${label}: ${fmtBytes(value)}, ${share(value)} of the database`,
    }));

  const cols: Column<TableRow>[] = [
    {
      label: 'Table',
      render: (t) => (
        <span title={areaOf(t.name)}>
          <span className="mono">{t.name}</span>
          <span className="muted small">{` · ${areaOf(t.name)}`}</span>
        </span>
      ),
    },
    {
      label: 'Rows',
      num: true,
      title: "PostgreSQL's estimate; exact counts would scan the table",
      render: (t) => (t.rowsEstimate === null ? '—' : `≈ ${fmtInt(t.rowsEstimate)}`),
    },
    { label: 'Data', num: true, render: (t) => fmtBytes(t.tableBytes) },
    { label: 'Indexes', num: true, render: (t) => fmtBytes(t.indexBytes) },
    {
      label: 'Total',
      num: true,
      title: 'Data, indexes and large values stored apart (TOAST)',
      render: (t) => <b>{fmtBytes(t.totalBytes)}</b>,
    },
    { label: 'Share', num: true, render: (t) => share(t.totalBytes) },
  ];

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Database storage</h2>
        <HelpButton topic="storage" />
        {r ? <span className="hint">{`measured ${fmtAgo(r.measuredAt)}`}</span> : null}
      </div>
      {error ? (
        <LoadError error={error} />
      ) : !r ? (
        <SkeletonBlock height={320} />
      ) : (
        <>
          <div className="storage-total">
            <b>{fmtBytes(total)}</b>
            <span className="muted small">
              {`in ${fmtInt(r.tables.length)} tables · hourly detail kept ${r.retention.detailDays ? `${r.retention.detailDays} days` : 'forever'} · LBank candles kept ${r.retention.candleDays ? `${r.retention.candleDays} days after their windows` : 'forever'}`}
            </span>
          </div>
          <div className="grid-2">
            <div>
              <h3 className="small muted">By area</h3>
              <HBars items={bars} fmt={fmtBytes} empty="No tables." />
            </div>
            <div className="table-wrap">
              <Table
                cols={cols}
                rows={r.tables.slice(0, TOP)}
                empty="No tables."
                rowKey={(t) => t.name}
              />
              {r.tables.length > TOP ? (
                <p className="muted small">{`${fmtInt(r.tables.length - TOP)} smaller tables not listed.`}</p>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

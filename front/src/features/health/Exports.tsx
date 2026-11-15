// Exports: CSV per sheet and an Excel workbook per scanned batch, with the manifest's checksums.
// Download links go through apiUrl() (the API may live on another host).
import { useCallback, useEffect, useState } from 'react';

import { type Column, LoadError, StatusLabel, Table } from '../../components/ui';
import { api } from '../../lib/api';
import { apiUrl } from '../../lib/config';
import { QUEUE, statusText } from '../../lib/constants';
import { fmtInt, fmtTime, shortId } from '../../lib/format';
import { useApp } from '../../state/app';

import type { ExportRow } from './types';

const fileUrl = (batchId: string, name: string) =>
  apiUrl(`exports/${encodeURIComponent(batchId)}/${encodeURIComponent(name)}`);

const COLS: Column<ExportRow>[] = [
  {
    label: 'Batch',
    render: (x) => `${fmtTime(x.asOf)}, ${shortId(x.batchId)}${x.isLive ? '' : ', synthetic'}`,
  },
  {
    label: 'Status',
    render: (x) =>
      x.exportStatus === 'succeeded' ? (
        <StatusLabel dot="good" text="Exported" />
      ) : (
        <StatusLabel dot="critical" text={`Failed: ${x.error || ''}`} />
      ),
  },
  { label: 'Queue', render: (x) => statusText(QUEUE, x.queueStatus) },
  {
    label: 'Files',
    render: (x) =>
      x.available ? (
        <span className="files">
          {(x.exportFiles || []).map((f) => (
            <a
              key={f.name}
              className="chip link-chip"
              href={fileUrl(x.batchId, f.name)}
              download
              title={`sha256 ${f.sha256}`}
            >
              {`${f.name} (${fmtInt(f.rows)})`}
            </a>
          ))}
          <a className="chip link-chip" href={fileUrl(x.batchId, 'manifest.json')} download>
            manifest.json
          </a>
        </span>
      ) : (
        <span className="muted">files pruned (the database keeps the results)</span>
      ),
  },
];

export default function Exports() {
  const { dataVersion } = useApp();
  const [rows, setRows] = useState<ExportRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<ExportRow[]>('exports'));
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [dataVersion, load]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Exported batches</h2>
        <span className="hint">{rows && rows.length ? `${rows.length} batches` : ''}</span>
      </div>
      <div className="table-wrap">
        {error ? (
          <LoadError error={error} />
        ) : rows ? (
          <Table cols={COLS} rows={rows} empty="No exports yet." rowKey={(x) => x.batchId} />
        ) : null}
      </div>
    </div>
  );
}

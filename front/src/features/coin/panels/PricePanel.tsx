import { type ReactNode, useEffect, useState } from 'react';

import { api, errorMessage } from '../../../lib/api';
import { fmtPrice, fmtTime, fmtUsd, num, tz } from '../../../lib/format';

import SeriesChart from '../charts/SeriesChart';
import type { AssetTrace, SnapshotRow, Snapshots } from '../types';

type Range = 'daily' | '72' | '168' | '720';
const RANGES: readonly (readonly [Range, string])[] = [
  ['daily', '30 days, daily'],
  ['72', '72 h'],
  ['168', '7 days'],
  ['720', '30 days, hourly'],
];
/** The chosen range is kept across coins while the page is open. */
let savedRange: Range = 'daily';

type SnapState =
  | { state: 'idle' }
  | { state: 'ok'; range: Range; rows: SnapshotRow[] }
  | { state: 'error'; range: Range; error: unknown };

const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getTime();
const backfillNote = (x: SnapshotRow) =>
  (x.qualityFlags || []).includes('historical_backfill')
    ? 'backfilled from genuine chart history'
    : null;

export default function PricePanel({ t }: { t: AssetTrace }) {
  const r = t.record;
  const [range, setRange] = useState<Range>(savedRange);
  const [snaps, setSnaps] = useState<SnapState>({ state: 'idle' });

  useEffect(() => {
    if (range === 'daily') return undefined;
    let stale = false;
    api<Snapshots>(`assets/${r.cmcId}/snapshots?hours=${range}`)
      .then((s) => {
        if (!stale) setSnaps({ state: 'ok', range, rows: s.snapshots || [] });
      })
      .catch((error: unknown) => {
        if (!stale) setSnaps({ state: 'error', range, error });
      });
    return () => {
      stale = true;
    };
  }, [range, r.cmcId]);

  let body: ReactNode;
  if (range === 'daily') {
    const days = [...t.daily.used].sort((a, b) => (a.dateUtc < b.dateUtc ? -1 : 1));
    body = (
      <SeriesChart
        label="Close"
        barLabel="Daily volume"
        tone="violet"
        height={230}
        fmt={fmtPrice}
        barFmt={fmtUsd}
        xfmt={(ts) =>
          new Date(ts).toLocaleDateString('en-GB', {
            timeZone: 'UTC',
            month: 'short',
            day: 'numeric',
          })
        }
        xfmtLong={(ts) =>
          `${new Date(ts).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })} (UTC close)`
        }
        points={days.map((d) => ({ t: dayStart(d.dateUtc), v: num(d.closeUsd) }))}
        bars={days.map((d) => ({ t: dayStart(d.dateUtc), v: num(d.volumeUsd) }))}
        empty="No daily closes stored for this coin yet."
      />
    );
  } else if (snaps.state === 'idle' || snaps.range !== range) {
    body = (
      <div className="skeleton short">
        <i />
      </div>
    );
  } else if (snaps.state === 'error') {
    body = <div className="error">Could not load snapshots: {errorMessage(snaps.error)}</div>;
  } else {
    const rows = snaps.rows;
    body = (
      <SeriesChart
        key={range}
        label="Price"
        barLabel="Rolling 24h volume"
        tone="violet"
        height={230}
        fmt={fmtPrice}
        xfmt={(ts) =>
          new Date(ts).toLocaleString('en-GB', {
            timeZone: tz(),
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            hour12: false,
          })
        }
        xfmtLong={(ts) => fmtTime(new Date(ts).toISOString())}
        points={rows.map((x) => ({
          t: new Date(x.slotTime).getTime(),
          v: num(x.price),
          note: backfillNote(x),
        }))}
        bars={rows.map((x) => ({ t: new Date(x.slotTime).getTime(), v: num(x.volumeRolling24h) }))}
        empty={`Hourly snapshots build up with each run: ${rows.length} stored for this coin so far. Use the daily view meanwhile.`}
      />
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Price and volume</h3>
        <span className="hint">now {fmtPrice(r.priceUsd)}</span>
      </div>
      <div className="seg" role="group" aria-label="Price range">
        {RANGES.map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={range === k}
            onClick={() => {
              savedRange = k;
              setRange(k);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div>{body}</div>
    </section>
  );
}

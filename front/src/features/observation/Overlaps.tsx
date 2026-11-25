// The same coin's other LBank observations whose 168-hour windows overlap a row's window (each from
// its own proven start), loaded when the dialog opens. Correlated: one price path.
import { useEffect, useState } from 'react';

import { Lab, Stars } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { infoDialog } from '../../lib/feedback';
import { fmtPct, fmtPrice, fmtTime, utc } from '../../lib/format';

import { STATUS } from './labels';
import type { ObservationOverlaps, ObservationRow } from './types';

const RELATION: Record<ObservationOverlaps['overlaps'][number]['relation'], string> = {
  same_utc_day: 'Same UTC day, different star count: its own event',
  earlier: 'Signalled earlier; its window was still running',
  later: 'Signalled later, inside this window',
};

const pct = (v: string | null, provisional: boolean) =>
  v === null ? '—' : `${fmtPct(v)}${provisional ? ' *' : ''}`;

function OverlapList({ id }: { id: string }) {
  const [data, setData] = useState<ObservationOverlaps | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<ObservationOverlaps>(`observations/${id}/overlaps`).then(setData, (e: unknown) =>
      setError(errorMessage(e)),
    );
  }, [id]);
  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <p className="muted small">Loading…</p>;
  const o = data.observation;
  return (
    <div className="fwd-explain">
      <p>
        {`This event: ${o.symbol} ${o.stars}★, CMC crawl ${fmtTime(o.crawlAt)}, window ${o.window ? `${fmtTime(o.window.start)} – ${fmtTime(o.window.end)}` : 'start pending'}${o.reference.price ? `, reference ${fmtPrice(o.reference.price)}` : ''}.`}
      </p>
      <p className="muted small">
        {`${o.symbol} has ${data.coin.events} observations in all. Those below share part of this window: each is its own event (one per coin, UTC day and star count), but they follow the same LBank price, so their results are correlated rather than independent. This row is not included. * = provisional.`}
      </p>
      {data.overlaps.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Stars</th>
                <th scope="col">Window start</th>
                <th scope="col" className="num">
                  Reference
                </th>
                <th scope="col" className="num">
                  Highest
                </th>
                <th scope="col" className="num">
                  Lowest
                </th>
                <th scope="col">Status</th>
                <th scope="col">Why it overlaps</th>
              </tr>
            </thead>
            <tbody>
              {data.overlaps.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Stars n={x.stars} />
                  </td>
                  <td title={`crawl ${utc(x.crawlAt)}`}>
                    {x.window ? fmtTime(x.window.start) : '—'}
                  </td>
                  <td className="num">{x.reference.price ? fmtPrice(x.reference.price) : '—'}</td>
                  <td className="num">{pct(x.highest?.pct ?? null, x.provisional)}</td>
                  <td className="num">{pct(x.lowest?.pct ?? null, x.provisional)}</td>
                  <td>
                    <Lab map={STATUS} k={x.status} />
                  </td>
                  <td className="wrap">
                    {`${RELATION[x.relation]}. Shared ${fmtTime(x.overlapStart)} – ${fmtTime(x.overlapEnd)} (${Math.round(Number(x.overlapHours))} h).`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No overlapping observation.</p>
      )}
    </div>
  );
}

export const openObservationOverlaps = (r: ObservationRow) =>
  void infoDialog(`${r.symbol}: ${r.overlapping} overlapping`, <OverlapList id={r.id} />, {
    wide: true,
  });

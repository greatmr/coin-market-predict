// The same coin's other LBank observations whose 168-hour windows overlap a row's window, loaded
// when the dialog opens (like the forward test's overlap list). Correlated: one price path.
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
        {`This event: ${o.symbol} ${o.stars}★, signal ${fmtTime(o.signalAt)}, window to ${fmtTime(o.windowEnd)}${o.entry ? `, LBank entry ${fmtPrice(o.entry.price)}` : ''}.`}
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
                <th scope="col">Signal</th>
                <th scope="col" className="num">
                  LBank entry
                </th>
                <th scope="col" className="num">
                  Max rise
                </th>
                <th scope="col" className="num">
                  Max drop
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
                  <td title={utc(x.signalAt)}>{fmtTime(x.signalAt)}</td>
                  <td className="num">{x.entry ? fmtPrice(x.entry.price) : '—'}</td>
                  <td className="num">{pct(x.maxRisePct, x.provisional)}</td>
                  <td className="num">{pct(x.maxDropPct, x.provisional)}</td>
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

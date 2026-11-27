// The same coin's other observations whose 168-hour windows overlap a row's window (each from its own
// proven start), loaded when the dialog opens: a timeline of the windows, then each one's start and
// why it overlaps. Each stays its own observation (one per coin, UTC day and star count); they are
// listed together, never merged. Correlated: one price path.
import { useEffect, useState } from 'react';

import { Lab, Stars } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { infoDialog } from '../../lib/feedback';
import { fmtPct, fmtPrice, fmtTime, utc } from '../../lib/format';

import { FUT_STATUS, STATUS, spanText } from './labels';
import type { ObservationOverlaps, ObservationRow } from './types';

const pct = (v: string | null | undefined, provisional: boolean) =>
  v === null || v === undefined ? '—' : `${fmtPct(v)}${provisional ? ' *' : ''}`;

type Win = { start: number; end: number };
const winOf = (r: ObservationRow): Win => {
  const start = Date.parse(r.window?.start ?? r.crawlAt);
  return { start, end: r.window ? Date.parse(r.window.end) : start + 168 * 3_600_000 };
};

/** Why two windows of one coin overlap, in words. */
function why(me: Win, x: Win, relation: string): string {
  const gap = Math.abs(x.start - me.start);
  if (relation === 'same_utc_day')
    return `Same CMC UTC day, different star count: its own event. It started ${spanText(gap)} ${x.start < me.start ? 'before' : 'after'} this one, and both windows last 168 h.`;
  if (x.start < me.start)
    return `It started ${spanText(gap)} before this one; 168 h windows that start less than 168 h apart share time.`;
  return `It started ${spanText(gap)} after this one, while this window was still running.`;
}

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
  const me = winOf(o);
  const all = [{ r: o, w: me, self: true }, ...data.overlaps.map((x) => ({ r: x, w: winOf(x), self: false }))].sort(
    (a, b) => a.w.start - b.w.start,
  );
  const lo = Math.min(...all.map((a) => a.w.start));
  const hi = Math.max(...all.map((a) => a.w.end));
  const span = Math.max(1, hi - lo);
  return (
    <div className="fwd-explain">
      <p>
        {`${o.symbol} has ${data.coin.events} observations. ${data.overlaps.length} of them have windows that share time with this ${o.stars}★ window (${o.window ? `${fmtTime(o.window.start)} – ${fmtTime(o.window.end)}` : 'start pending'}). They follow the same LBank price, so their results are correlated, not independent; each keeps its own start, reference and status.`}
      </p>
      <div className="obs-gantt" role="img" aria-label="Timeline of the overlapping 168-hour windows">
        {all.map(({ r, w, self }) => (
          <div key={r.id} className={`row${self ? ' self' : ''}`}>
            <span className="lab">
              <Stars n={r.stars} /> {fmtTime(r.window?.start ?? r.crawlAt)}
              {self ? <b> (this)</b> : null}
            </span>
            <span className="track">
              <span
                className="bar"
                style={{
                  left: `${((w.start - lo) / span) * 100}%`,
                  width: `${((w.end - w.start) / span) * 100}%`,
                }}
              />
            </span>
          </div>
        ))}
        <div className="row axis">
          <span className="lab" />
          <span className="track">
            <span>{fmtTime(new Date(lo).toISOString())}</span>
            <span>{fmtTime(new Date(hi).toISOString())}</span>
          </span>
        </div>
      </div>
      {data.overlaps.length ? (
        <div className="table-wrap obs-ovl">
          <table>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Window</th>
                <th scope="col">Why it overlaps</th>
                <th scope="col" className="num">Spot ref.</th>
                <th scope="col" className="num">Spot high / low</th>
                <th scope="col">Status (Spot · Futures)</th>
              </tr>
            </thead>
            <tbody>
              {data.overlaps.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Stars n={x.stars} />
                    <div className="muted small">{`CMC ${x.crawlAt.slice(0, 10)}`}</div>
                  </td>
                  <td title={`${utc(x.window?.start)} – ${utc(x.window?.end)}`}>
                    {x.window ? fmtTime(x.window.start) : '—'}
                    <div className="muted small">{`shares ${fmtTime(x.overlapStart)} – ${fmtTime(x.overlapEnd)} (${Math.round(Number(x.overlapHours))} h)`}</div>
                  </td>
                  <td className="wrap">{why(me, winOf(x), x.relation)}</td>
                  <td className="num">{x.reference.price ? fmtPrice(x.reference.price) : '—'}</td>
                  <td className="num">{`${pct(x.highest?.pct, x.provisional)} / ${pct(x.lowest?.pct, x.provisional)}`}</td>
                  <td>
                    <Lab map={STATUS} k={x.status} />
                    {x.futuresSampled ? (
                      <div>
                        <Lab map={FUT_STATUS} k={x.futuresSampled.status} />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No overlapping observation.</p>
      )}
      <p className="muted small">* provisional (window running or data still being verified). Overlap is not a review flag.</p>
    </div>
  );
}

export const openObservationOverlaps = (r: ObservationRow) =>
  void infoDialog(`${r.symbol}: ${r.overlapping} overlapping windows`, <OverlapList id={r.id} />, {
    wide: true,
  });

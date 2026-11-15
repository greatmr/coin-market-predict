// The first 12 coins of the Review Queue as cards.
import { useEffect, useState } from 'react';

import { Chip, Logo, MultBar, Stars } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { fmtMult, fmtUsd, fmtVmc, num } from '../../lib/format';
import { useApp } from '../../state/app';
import type { Num, ScanSummary } from '../../types/api';

import type { QueueSheet } from './types';

interface StripState {
  key: string | null;
  data: QueueSheet | null;
  error: unknown;
}

export default function QueueStrip({ sc }: { sc: ScanSummary | null }) {
  const { openCoin } = useApp();
  const [state, setState] = useState<StripState>({ key: null, data: null, error: null });
  // Reload when the scanned batch (or its reprocessing) changes.
  const key = sc ? `${sc.batchId}:${sc.finishedAt}` : null;

  useEffect(() => {
    if (!key || state.key === key) return undefined;
    let cancelled = false;
    api<QueueSheet>('scan?sheet=queue&limit=12')
      .then((data) => {
        if (!cancelled) setState({ key, data, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ key: null, data: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, [key, state.key]);

  if (!sc) return <div className="empty">No scan yet.</div>;
  if (state.error)
    return <div className="error">Could not load the queue: {errorMessage(state.error)}</div>;
  const data = state.data;
  if (!data) return null;
  if (!data.rows.length)
    return (
      <div className="empty">
        No eligible coin has a current VMC at least 1.5× any of its own 3, 7 or 30-day means right
        now.
      </div>
    );
  return (
    <>
      {data.rows.map((r) => {
        const windows: [string, string | null, Num | null][] = [
          ['3d', r.pass3d, r.multiple3d],
          ['7d', r.pass7d, r.multiple7d],
          ['30d', r.pass30d, r.multiple30d],
        ];
        return (
          <button
            key={r.cmcId}
            type="button"
            className="qcard"
            onClick={() => openCoin(r.cmcId, data.batchId)}
          >
            <div className="qcard-head">
              <Logo cmcId={r.cmcId} size={28} />
              <div className="coin-text">
                <b>{r.symbol}</b>
                <span>{r.name}</span>
              </div>
              <Stars n={r.stars} />
            </div>
            <div className="qcard-vmc">
              <b>{fmtVmc(r.currentVmc)}</b>
              <span>current VMC</span>
            </div>
            <div className="qcard-mults">
              {windows.map(([w, s, mm]) => (
                <div key={w} className="qm">
                  <span>{w}</span>
                  {s === 'N/A' ? (
                    <span className="pass na">N/A</span>
                  ) : (
                    <MultBar m={num(mm)} status={s} />
                  )}
                  <b className={s === 'YES' ? 'yes' : undefined}>
                    {s === 'N/A' ? '' : fmtMult(mm)}
                  </b>
                </div>
              ))}
            </div>
            <div className="qcard-foot">
              <span>{`#${r.queueOrder}`}</span>
              <span>{`cap ${fmtUsd(r.capUsd)}`}</span>
              {r.review ? <Chip tone="violet">{r.review.finalDecision}</Chip> : null}
            </div>
          </button>
        );
      })}
    </>
  );
}

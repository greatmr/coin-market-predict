import { Donut, type DonutSeg } from '../../../components/charts';
import { Chip } from '../../../components/ui';
import { fmtAgo, fmtUsd, num } from '../../../lib/format';
import type { Num } from '../../../types/api';

import type { AssetTrace } from '../types';

const TONES = ['violet', 'base', 'surge', 'rose', 'warn'];

/** Where it trades: CMC-reported spot volume by exchange (top five, then the rest). */
export default function VenuePanel({ t }: { t: AssetTrace }) {
  const v = t.venues?.summary ?? null;
  const head = (
    <div className="panel-head">
      <h3>Where it trades</h3>
      <span className="hint">
        {v
          ? `${v.pairsUsed} of ${v.expectedCount ?? '?'} spot pairs, ${fmtAgo(v.observedAt)}`
          : 'not collected'}
      </span>
    </div>
  );
  if (!v || !v.exchanges?.length)
    return (
      <section className="panel">
        {head}
        <div className="empty">
          Venue rows are collected for review candidates (the queue, or needs review with a YES).
        </div>
      </section>
    );
  const vol = (x: { volumeUsd: Num | null }) => num(x.volumeUsd) || 0;
  const ex = [...v.exchanges].sort((a, b) => vol(b) - vol(a));
  const rest = ex.slice(5).reduce((a, e) => a + vol(e), 0);
  const segs: DonutSeg[] = ex.slice(0, 5).map((e, i) => ({
    label: e.name,
    value: Math.round(vol(e)),
    tone: TONES[i] ?? 'muted',
  }));
  if (rest > 0)
    segs.push({ label: `${ex.length - 5} others`, value: Math.round(rest), tone: 'muted' });
  return (
    <section className="panel">
      {head}
      <Donut segs={segs} size={140} totalLabel="24h volume" fmt={fmtUsd} />
      {(v.flags || []).length ? (
        <div className="chips">
          {(v.flags || []).map((f) => (
            <Chip key={f} tone="warn">
              {f.replace(/_/g, ' ').toLowerCase()}
            </Chip>
          ))}
        </div>
      ) : null}
      <p className="muted small">
        CMC-reported spot volume by exchange. Upbit-dominant or single-venue activity is flagged for
        your judgment; there is no share cutoff.
      </p>
    </section>
  );
}

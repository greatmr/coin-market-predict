// Data quality: current quote and LBank status mix, the LBank list, scan warnings, last export.
import { useState } from 'react';

import { apiPost, errorMessage } from '../../lib/api';
import { CURRENT, LBANK, type StatusMap, statusText } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo, fmtInt, fmtTime, shortId } from '../../lib/format';
import { useApp } from '../../state/app';
import type { OperateResult, Overview, ScanSummary } from '../../types/api';

import { StackBar } from './charts';
import type { LbankList, ScanCountsDetail, StackSeg, Tally } from './types';

const CUR_TONES: Record<string, string> = {
  OK: 'base',
  STALE: 'warn',
  TIMESTAMP_UNVERIFIED: 'warn',
  MISMATCHED: 'rose',
  MISSING: 'rose',
  INVALID: 'rose',
};
const LB_TONES: Record<string, string> = {
  VERIFIED: 'base',
  PAIR_LISTED_UNVERIFIED: 'warn',
  NOT_LISTED: 'muted',
  NOT_TRADABLE: 'rose',
  UNKNOWN: 'warn',
};
const segsOf = (
  obj: Tally | undefined,
  map: StatusMap,
  tones: Record<string, string>,
): StackSeg[] =>
  Object.entries(obj || {}).map(([k, v]) => ({
    value: v,
    tone: tones[k] || 'muted',
    label: statusText(map, k),
  }));

export function qualityMeta(ov: Overview | null): string {
  return ov && ov.crawlAgeMinutes !== undefined && ov.crawlAgeMinutes !== null
    ? `crawled ${fmtInt(ov.crawlAgeMinutes)} min ago`
    : '';
}

/** The LBank list from GET /api/lbank, when it has the expected shape. */
function lbankList(list: unknown): LbankList | null {
  if (!list || typeof list !== 'object') return null;
  const l = list as Partial<LbankList>;
  return typeof l.pairs === 'number' ? (l as LbankList) : null;
}

const warningsOf = (w: unknown): string[] => (Array.isArray(w) ? w.map(String) : []);

export default function Quality({
  ov,
  sc,
  c,
}: {
  ov: Overview;
  sc: ScanSummary | null;
  c: ScanCountsDetail;
}) {
  const { lbank, can } = useApp();
  if (!sc) return <div className="empty">No scan yet.</div>;
  const rows = [
    { label: 'Current quotes', segs: segsOf(c.current, CURRENT, CUR_TONES) },
    { label: 'LBank status', segs: segsOf(c.lbank, LBANK, LB_TONES) },
  ];
  const l = lbankList(lbank?.list);
  const warnings = warningsOf(sc.warnings);
  return (
    <>
      <div className="quality-stack">
        {rows.map((r) => (
          <div key={r.label} className="q-row">
            <span className="q-label">{r.label}</span>
            <StackBar segs={r.segs} />
            <span className="q-legend">
              {r.segs.map((s, i) => (
                <span key={i} className={s.tone}>{`${s.label} ${fmtInt(s.value)}`}</span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="lbank-line">
        {l ? (
          <div>
            <b>{`${fmtInt(l.pairs)} LBank spot pairs`}</b>
            <span className="muted">
              {` fetched ${fmtAgo(l.fetchedAt)}, next refresh ${fmtTime(l.nextRefreshAt)}`}
            </span>
            {l.stale ? (
              <div className="error small">
                {`Older than ${lbank?.maxAgeDays} days: LBank status is unknown and the queue is withheld until it is refreshed.`}
              </div>
            ) : null}
            {l.lastAttempt && l.lastAttempt.status !== 'COMPLETE' ? (
              <div className="error small">
                {`Last refresh ${fmtTime(l.lastAttempt.at)} ${l.lastAttempt.status}${l.lastAttempt.error ? `: ${l.lastAttempt.error}` : ''}. The list above stays in use.`}
              </div>
            ) : null}
          </div>
        ) : (
          <span className="muted">No complete LBank list yet. The next run fetches it.</span>
        )}
        {can('scan:operate') ? <RefreshLbankButton /> : null}
      </div>
      {warnings.length ? (
        <ul className="notes warnings">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No warnings for the latest scan.</p>
      )}
      {ov.export ? (
        <p className="muted small">
          {`Last export ${fmtTime(ov.export.exportedAt)}, batch ${shortId(ov.export.batchId)}.`}
        </p>
      ) : null}
    </>
  );
}

function RefreshLbankButton() {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await apiPost<OperateResult>('lbank/refresh', {});
      if (r.ok)
        toast(
          `LBank list refreshed: ${fmtInt(r.pairs)} pairs. Queue ${r.counts ? fmtInt(r.counts.queue) : '?'}.`,
        );
      else
        toast(
          `LBank list not refreshed: ${r.reason || `${r.status}${r.notes && r.notes.length ? `, ${r.notes[0]}` : ''}`}`,
          'warning',
        );
      await refresh(true);
    } catch (err) {
      toast(`LBank refresh failed: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="btn"
      disabled={busy}
      title="Fetch the Markets list of CMC's LBank page now, then recompute the latest batch"
      onClick={run}
    >
      {busy ? 'Refreshing, about a minute…' : 'Refresh LBank list now'}
    </button>
  );
}

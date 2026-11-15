import { type ReactNode, useState } from 'react';

import { ChartBox } from '../../../components/charts';
import { reasonText } from '../../../lib/constants';
import { fmtMult, fmtVmc, isNum, num } from '../../../lib/format';
import { useApp } from '../../../state/app';

import VmcChart from '../charts/VmcChart';
import type { AssetTrace } from '../types';

const sortedDays = (t: AssetTrace) =>
  [...t.daily.used].sort((a, b) => (a.dateUtc < b.dateUtc ? -1 : 1));

/** Volume ÷ market cap: completed UTC days against the chosen window, then now. */
export default function VmcPanel({ t }: { t: AssetTrace }) {
  const { passLine } = useApp();
  const r = t.record;
  const days = sortedDays(t);
  const wins = t.windows || [];
  const cur = num(r.currentVmc);
  const [sel, setSel] = useState<number | undefined>(
    () => (wins.find((w) => w.pass?.status === 'YES') || wins.find((w) => w.pass) || wins[0])?.days,
  );
  const win = wins.find((w) => w.days === sel);

  let caption: ReactNode = '';
  if (win) {
    const mean = num(win.mean);
    if (!isNum(mean))
      caption = `The ${win.days}-day mean is not available: ${reasonText(win.reason)}.`;
    else if (!isNum(cur))
      caption = `The ${win.days}-day mean is ${fmtVmc(mean)}, but there is no valid current quote to compare.`;
    else
      caption = (
        <span>
          {'Current VMC '}
          <b className="surge-text">{fmtVmc(cur)}</b>
          {` is ${fmtMult(cur / mean)} the ${win.days}-day mean of `}
          <b className="base-text">{fmtVmc(mean)}</b>
          {win.pass
            ? `. YES needs at least ${passLine}×, so this window is ${win.pass.status}.`
            : '. The 14-day window is context only.'}
        </span>
      );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Volume ÷ market cap</h3>
        <span className="hint">completed UTC days, then now</span>
      </div>
      <div className="seg win-seg" role="group" aria-label="Compare with window">
        {wins.map((w) => {
          const p = w.pass;
          const cls = p ? (p.status === 'YES' ? 'yes' : p.status === 'NO' ? 'no' : 'na') : 'ctx';
          return (
            <button
              key={w.days}
              type="button"
              className={`win ${cls}`}
              aria-pressed={w.days === sel}
              onClick={() => setSel(w.days)}
            >
              <span className="win-days">{`${w.days} days`}</span>
              <span className="win-val">
                {p
                  ? p.status === 'N/A'
                    ? 'N/A'
                    : `${p.status} ${fmtMult(p.multiple)}`
                  : w.mean === null
                    ? 'N/A'
                    : 'context'}
              </span>
            </button>
          );
        })}
      </div>
      {days.length ? (
        <ChartBox>{(W) => <VmcChart W={W} days={days} cur={cur} win={win} />}</ChartBox>
      ) : (
        <div className="chart-box">
          <div className="empty chart-empty">No daily rows: excluded coins are not evaluated.</div>
        </div>
      )}
      <p className="chart-caption">{caption}</p>
    </section>
  );
}

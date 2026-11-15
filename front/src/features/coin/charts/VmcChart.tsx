// Daily VMC bars for the completed UTC days, the selected window's mean and 1.5× line, and today's
// rolling-24h VMC.
import { type ReactNode, useState } from 'react';

import { TipHead, TipRow } from '../../../components/Feedback';
import { niceTicks } from '../../../components/charts';
import { hideTip, showTip } from '../../../lib/feedback';
import { fmtDay, fmtMult, fmtPrice, fmtUsd, fmtVmc, isNum, num } from '../../../lib/format';
import { useApp } from '../../../state/app';

import type { DailyRow, TraceWindow } from '../types';

export default function VmcChart({
  W,
  days,
  cur,
  win,
}: {
  W: number;
  days: DailyRow[];
  cur: number | null;
  win: TraceWindow | undefined;
}) {
  const { passLine: pl } = useApp();
  const [on, setOn] = useState<number | null>(null);

  const H = 250;
  const m = { l: 6, r: 96, t: 18, b: 30 };
  const n = days.length;
  const slots = n + 2;
  const step = (W - m.l - m.r) / slots;
  const bw = Math.max(2, step * 0.64);
  const mean = win ? num(win.mean) : null;
  const thr = isNum(mean) ? mean * pl : null;
  const vals = days.map((d) => num(d.vmc)).filter(isNum);
  if (isNum(cur)) vals.push(cur);
  if (isNum(thr)) vals.push(thr);
  const ymax = Math.max(...vals, 1e-9) * 1.12;
  const plotB = H - m.b;
  const Y = (v: number) => plotB - (v / ymax) * (plotB - m.t);
  const slotX = (i: number) => m.l + i * step + (step - bw) / 2;
  const inWin = new Set(win ? win.dates : []);
  const winIdx = days.map((d, i) => (inWin.has(d.dateUtc) ? i : -1)).filter((i) => i >= 0);
  const nowX = slotX(n + 1);

  const hits: { x: number; rows: () => ReactNode }[] = days.map((d, i) => {
    const v = num(d.vmc);
    return {
      x: slotX(i) - (step - bw) / 2,
      rows: () => (
        <>
          <TipHead>{`${fmtDay(d.dateUtc)} (T−${d.daysAgo})`}</TipHead>
          <TipRow
            k="VMC"
            v={
              isNum(v)
                ? fmtVmc(v)
                : d.valid === false
                  ? `invalid: ${(d.invalidReasons || []).join(', ')}`
                  : 'missing'
            }
            tone="tone-base"
          />
          <TipRow k="Volume" v={fmtUsd(d.volumeUsd)} />
          <TipRow k="Market cap" v={fmtUsd(d.marketCapUsd)} />
          <TipRow k="Close" v={fmtPrice(d.closeUsd)} />
          {win && inWin.has(d.dateUtc) ? (
            <div className="tip-note">{`inside the ${win.days}-day window`}</div>
          ) : null}
        </>
      ),
    };
  });
  hits.push({
    x: nowX - (step - bw) / 2,
    rows: () => (
      <>
        <TipHead>Now (rolling 24h)</TipHead>
        <TipRow k="Current VMC" v={fmtVmc(cur)} tone="tone-surge" />
        {win && isNum(mean) ? (
          <TipRow k={`${win.days}d mean`} v={fmtVmc(mean)} tone="tone-base" />
        ) : null}
        {isNum(mean) && isNum(cur) ? <TipRow k="Multiple" v={fmtMult(cur / mean)} /> : null}
      </>
    ),
  });

  const hot = isNum(cur) && isNum(thr) && cur >= thr;
  const nowH = isNum(cur) ? Math.max(1.5, plotB - Y(cur)) : 0;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - m.l - m.r) / 64))));

  let lines: ReactNode = null;
  if (win && isNum(mean) && isNum(thr) && winIdx.length) {
    const a = slotX(winIdx[0]!);
    const b = nowX + bw;
    const ly1 = Y(mean),
      ly2 = Y(thr);
    const gap = Math.abs(ly1 - ly2) < 14 ? 7 : 0;
    lines = (
      <>
        <line className="mean-line" x1={a} x2={b} y1={ly1} y2={ly1} />
        <line className="thr-line" x1={a} x2={b} y1={ly2} y2={ly2} />
        <text className="line-label base" x={W - m.r + 8} y={ly1 + 4 + gap}>
          {`${win.days}d mean ${fmtVmc(mean)}`}
        </text>
        <text className="line-label surge" x={W - m.r + 8} y={ly2 + 4 - gap}>
          {`${pl}× ${fmtVmc(thr)}`}
        </text>
      </>
    );
  }

  let band: ReactNode = null;
  if (winIdx.length) {
    const a = slotX(winIdx[0]!) - (step - bw) / 2,
      b = slotX(winIdx[winIdx.length - 1]!) + bw + (step - bw) / 2;
    band = (
      <rect className="win-band" x={a} y={m.t - 8} width={b - a} height={plotB - m.t + 8} rx={8} />
    );
  }

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="chart vmc-chart"
      role="img"
      aria-label={`Daily volume ÷ market cap for ${n} completed days and the current rolling-24h value ${fmtVmc(cur)}.`}
    >
      {niceTicks(0, ymax, 3)
        .filter((v) => v !== 0)
        .map((v, i) => (
          <line key={`g${i}`} className="grid-line" x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} />
        ))}
      <line className="axis-line" x1={m.l} x2={W - m.r} y1={plotB} y2={plotB} />
      {band}
      {days.map((d, i) => {
        const v = num(d.vmc);
        const x = slotX(i);
        if (!isNum(v))
          return (
            <path
              key={`d${i}`}
              className="missing-mark"
              d={`M${x + bw / 2 - 4},${plotB - 12}l8,8M${x + bw / 2 + 4},${plotB - 12}l-8,8`}
            />
          );
        const h = Math.max(1.5, plotB - Y(v));
        return (
          <rect
            key={`d${i}`}
            className={`day-bar${inWin.has(d.dateUtc) ? ' in' : ''}`}
            x={x}
            y={plotB - h}
            width={bw}
            height={h}
            rx={Math.min(3, bw / 2)}
          />
        );
      })}
      {isNum(cur) ? (
        <>
          <rect
            className={`now-bar${hot ? ' hot' : ''}`}
            x={nowX}
            y={plotB - nowH}
            width={bw}
            height={nowH}
            rx={Math.min(3, bw / 2)}
          />
          <text
            className={`now-label${hot ? ' hot' : ''}`}
            x={nowX + bw / 2}
            y={Math.max(m.t - 4, plotB - nowH - 6)}
            textAnchor="middle"
          >
            {fmtVmc(cur)}
          </text>
        </>
      ) : null}
      {lines}
      {days.map((d, i) => {
        if ((n - 1 - i) % every) return null;
        if (nowX + bw / 2 - (slotX(i) + bw / 2) < 40) return null;
        return (
          <text key={`t${i}`} className="tick" x={slotX(i) + bw / 2} y={H - 9} textAnchor="middle">
            {fmtDay(d.dateUtc)}
          </text>
        );
      })}
      <text className="tick strong" x={nowX + bw / 2} y={H - 9} textAnchor="middle">
        Now
      </text>
      {hits.map((h, i) => (
        <rect
          key={`h${i}`}
          className={`hit${on === i ? ' on' : ''}`}
          x={h.x}
          y={0}
          width={step}
          height={plotB}
          onPointerEnter={(e) => {
            setOn(i);
            showTip(h.rows(), e.clientX, e.clientY);
          }}
          onPointerMove={(e) => showTip(h.rows(), e.clientX, e.clientY)}
          onPointerLeave={() => {
            setOn(null);
            hideTip();
          }}
        />
      ))}
    </svg>
  );
}

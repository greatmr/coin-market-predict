// Current VMC against the 30-day mean (log-log), one dot per coin on the page.
import { TipHead, TipRow } from '../../components/Feedback';
import { useSvgId } from '../../components/charts';
import { hideTip, showTip } from '../../lib/feedback';
import { fmtMult, fmtUsd, fmtVmc, isNum, num } from '../../lib/format';
import { useApp } from '../../state/app';

import type { SheetRow } from './types';

interface Pt {
  r: SheetRow;
  x: number;
  y: number;
}

const base = (r: SheetRow) => num(r.vmc30dAvg) ?? num(r.vmc7dAvg) ?? num(r.vmc3dAvg);

export default function ScatterChart({
  W,
  rows,
  onPick,
}: {
  W: number;
  rows: SheetRow[];
  onPick: (r: SheetRow) => void;
}) {
  const { passLine: pl } = useApp();
  const clip = useSvgId('clip');
  const H = Math.min(520, Math.max(340, W * 0.55));
  const m = { l: 72, r: 20, t: 18, b: 44 };
  const pts: Pt[] = [];
  for (const r of rows) {
    const x = base(r),
      y = num(r.currentVmc);
    if (isNum(x) && isNum(y) && x > 0 && y > 0) pts.push({ r, x, y });
  }
  if (!pts.length)
    return (
      <div className="empty chart-empty">
        No coin on this page has both a current VMC and a daily mean.
      </div>
    );

  const all = pts.flatMap((p) => [p.x, p.y]);
  const lo = Math.log10(Math.min(...all)) - 0.15,
    hi = Math.log10(Math.max(...all)) + 0.15;
  const X = (v: number) => m.l + ((Math.log10(v) - lo) / (hi - lo)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((Math.log10(v) - lo) / (hi - lo)) * (H - m.t - m.b);
  const decades: number[] = [];
  for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) decades.push(10 ** e);
  const a = 10 ** lo,
    b = 10 ** hi;
  const cap = (p: Pt) => num(p.r.capUsd) || 0;
  const cmax = Math.max(...pts.map(cap), 1);
  const sorted = [...pts].sort((p, q) => cap(q) - cap(p));

  const tip = (p: Pt) => (
    <>
      <TipHead>{`${p.r.symbol} · ${p.r.name}`}</TipHead>
      <TipRow k="Current VMC" v={fmtVmc(p.y)} tone="tone-surge" />
      <TipRow k="30d mean" v={fmtVmc(p.x)} tone="tone-base" />
      <TipRow k="Multiple" v={fmtMult(p.y / p.x)} />
      <TipRow k="Market cap" v={fmtUsd(p.r.capUsd)} />
      <div className="tip-note">Click to open</div>
    </>
  );

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="chart scatter"
      role="img"
      aria-label={`Scatter of ${pts.length} coins: current VMC against the 30-day mean.`}
    >
      {decades.map((v, i) => (
        <g key={i}>
          <line className="grid-line" x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} />
          <line className="grid-line" x1={X(v)} x2={X(v)} y1={m.t} y2={H - m.b} />
          <text className="tick" x={m.l - 8} y={Y(v) + 4} textAnchor="end">
            {fmtVmc(v)}
          </text>
          <text className="tick" x={X(v)} y={H - m.b + 16} textAnchor="middle">
            {fmtVmc(v)}
          </text>
        </g>
      ))}
      <defs>
        <clipPath id={clip}>
          <rect x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <line className="eq-line" x1={X(a)} y1={Y(a)} x2={X(b)} y2={Y(b)} />
        <line className="thr-line" x1={X(a / pl)} y1={Y(a)} x2={X(b / pl)} y2={Y(b)} />
      </g>
      <text className="line-label surge" x={X(b / pl) - 6} y={m.t + 12} textAnchor="end">
        {`${pl}× its mean`}
      </text>
      <text className="axis-title" x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle">
        30-day mean VMC
      </text>
      <text
        className="axis-title"
        x={14}
        y={(m.t + H - m.b) / 2}
        textAnchor="middle"
        transform={`rotate(-90 14 ${(m.t + H - m.b) / 2})`}
      >
        Current VMC
      </text>
      {sorted.map((p) => (
        <circle
          key={p.r.cmcId}
          className={`pt s${p.r.stars || 0}${p.r.inQueue ? ' q' : ''}`}
          cx={X(p.x)}
          cy={Y(p.y)}
          r={3.5 + Math.sqrt(cap(p) / cmax) * 10}
          onPointerEnter={(e) => showTip(tip(p), e.clientX, e.clientY)}
          onPointerMove={(e) => showTip(tip(p), e.clientX, e.clientY)}
          onPointerLeave={hideTip}
          onClick={() => {
            hideTip();
            onPick(p.r);
          }}
        />
      ))}
    </svg>
  );
}

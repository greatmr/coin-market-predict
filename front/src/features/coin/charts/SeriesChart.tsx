// Interactive time series: line + wash, optional faint volume bars underneath, crosshair, keyboard.
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';

import { TipHead, TipRow } from '../../../components/Feedback';
import { ChartBox, niceTicks, useSvgId } from '../../../components/charts';
import { hideTip, showTip } from '../../../lib/feedback';
import { fmtUsd, isNum } from '../../../lib/format';

export interface SeriesPoint {
  t: number;
  v: number | null;
  note?: string | null;
}
interface Point {
  t: number;
  v: number;
  note?: string | null;
}

export interface SeriesChartProps {
  label: string;
  fmt: (v: number) => string;
  xfmt: (t: number) => string;
  xfmtLong?: (t: number) => string;
  points: SeriesPoint[];
  bars?: SeriesPoint[];
  barLabel?: string;
  barFmt?: (v: number) => string;
  tone?: string;
  height?: number;
  empty?: ReactNode;
}

const hasValue = (p: SeriesPoint): p is Point => isNum(p.v);

export default function SeriesChart(o: SeriesChartProps) {
  const pts = o.points.filter(hasValue);
  if (pts.length < 2)
    return (
      <div className="chart-box">
        <div className="empty chart-empty">{o.empty || 'Not enough data for a chart yet.'}</div>
      </div>
    );
  return <ChartBox>{(W) => <SeriesSvg W={W} o={o} pts={pts} />}</ChartBox>;
}

function SeriesSvg({ W, o, pts }: { W: number; o: SeriesChartProps; pts: Point[] }) {
  const gid = useSvgId('wash');
  const rootRef = useRef<SVGSVGElement | null>(null);
  const idxRef = useRef(pts.length - 1);
  const [cross, setCross] = useState<number | null>(null);

  const H = o.height || 220;
  const m = { l: 6, r: 62, t: 14, b: 26 };
  const bars = (o.bars || []).filter(hasValue);
  const plotB = H - m.b;
  const lineB = bars.length ? m.t + (plotB - m.t) * 0.72 : plotB;
  const t0 = pts[0]!.t,
    t1 = pts[pts.length - 1]!.t;
  const X = (t: number) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
  let lo = Math.min(...pts.map((p) => p.v)),
    hi = Math.max(...pts.map((p) => p.v));
  if (lo === hi) {
    lo = lo * 0.98;
    hi = hi * 1.02 || 1;
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const Y = (v: number) => lineB - ((v - lo) / (hi - lo)) * (lineB - m.t);

  const yTicks = niceTicks(lo, hi, 3).filter((v) => !(Y(v) < m.t || Y(v) > lineB));
  const xCount = Math.max(2, Math.floor((W - m.l - m.r) / 110));
  const xTicks = Array.from({ length: xCount + 1 }, (_, i) => t0 + ((t1 - t0) * i) / xCount);

  const bmax = bars.length ? Math.max(...bars.map((b) => b.v)) || 1 : 1;
  const bw = Math.max(1.5, ((W - m.l - m.r) / Math.max(bars.length, 2)) * 0.62);
  const barTop = lineB + 10;

  let d = '';
  pts.forEach((p, i) => {
    d += `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`;
  });
  const last = pts[pts.length - 1]!;

  const show = (i: number, cx: number, cy: number) => {
    const p = pts[i]!;
    const b = bars.find((x) => x.t === p.t);
    setCross(i);
    showTip(
      <>
        <TipHead>{o.xfmtLong ? o.xfmtLong(p.t) : o.xfmt(p.t)}</TipHead>
        <TipRow k={o.label} v={o.fmt(p.v)} tone="tone-line" />
        {b ? (
          <TipRow k={o.barLabel || 'Volume'} v={(o.barFmt || fmtUsd)(b.v)} tone="tone-bar" />
        ) : null}
        {p.note ? <div className="tip-note">{p.note}</div> : null}
      </>,
      cx,
      cy,
    );
  };
  const hide = () => {
    setCross(null);
    hideTip();
  };
  const nearest = (x: number) => {
    let best = 0,
      bd = Infinity;
    pts.forEach((p, i) => {
      const dd = Math.abs(X(p.t) - x);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return best;
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const k = (
      { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity } as Record<string, number>
    )[e.key];
    if (k === undefined || !rootRef.current) return;
    e.preventDefault();
    const idx = Math.max(0, Math.min(pts.length - 1, idxRef.current + k));
    idxRef.current = idx;
    const r = rootRef.current.getBoundingClientRect();
    show(idx, r.left + X(pts[idx]!.t), r.top + Y(pts[idx]!.v));
  };
  const cp = cross === null ? null : pts[cross]!;

  return (
    <svg
      ref={rootRef}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className={`chart tone-${o.tone || 'base'}`}
      role="img"
      tabIndex={0}
      aria-label={`${o.label}: ${pts.length} values, latest ${o.fmt(last.v)}. Use the arrow keys to read values.`}
      onKeyDown={onKey}
      onBlur={hide}
    >
      <defs>
        <linearGradient id={gid} x1={0} y1={0} x2={0} y2={1}>
          <stop offset="0%" className="wash-top" />
          <stop offset="100%" className="wash-bottom" />
        </linearGradient>
      </defs>
      {yTicks.map((v, i) => (
        <g key={`y${i}`}>
          <line className="grid-line" x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} />
          <text className="tick" x={W - m.r + 8} y={Y(v) + 4}>
            {o.fmt(v)}
          </text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <text
          key={`x${i}`}
          className="tick"
          x={X(t)}
          y={H - 7}
          textAnchor={i === 0 ? 'start' : i === xCount ? 'end' : 'middle'}
        >
          {o.xfmt(t)}
        </text>
      ))}
      {bars.map((b, i) => {
        const h = Math.max(1, (b.v / bmax) * (plotB - barTop));
        return (
          <rect
            key={`b${i}`}
            className="vol-bar"
            x={X(b.t) - bw / 2}
            y={plotB - h}
            width={bw}
            height={h}
            rx={Math.min(2, bw / 2)}
          />
        );
      })}
      <path
        className="wash"
        fill={`url(#${gid})`}
        d={`${d}L${X(t1).toFixed(1)},${lineB}L${X(t0).toFixed(1)},${lineB}Z`}
      />
      <path className="series" d={d} />
      <circle className="end-dot" cx={X(last.t)} cy={Y(last.v)} r={3.5} />
      <line
        className="cross"
        x1={cp ? X(cp.t) : 0}
        x2={cp ? X(cp.t) : 0}
        y1={m.t}
        y2={plotB}
        visibility={cp ? 'visible' : 'hidden'}
      />
      <circle
        className="cross-dot"
        r={4.5}
        cx={cp ? X(cp.t) : 0}
        cy={cp ? Y(cp.v) : 0}
        visibility={cp ? 'visible' : 'hidden'}
      />
      <rect
        className="hit"
        x={m.l}
        y={0}
        width={Math.max(1, W - m.l - m.r)}
        height={plotB}
        onPointerMove={(e) => {
          if (!rootRef.current) return;
          const r = rootRef.current.getBoundingClientRect();
          show(nearest(e.clientX - r.left), e.clientX, e.clientY);
        }}
        onPointerLeave={hide}
      />
    </svg>
  );
}

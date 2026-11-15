// Chart primitives shared by several sections. Charts are hand-drawn SVG (no third-party scripts:
// the CSP allows only self-hosted code); sizes go through React style props (CSSOM), never inline
// style attributes in HTML.
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';

import { fmtInt } from '../lib/format';

/** Width of a box, tracked with a ResizeObserver (0 until first measured). */
export function useWidth<T extends HTMLElement = HTMLDivElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    const ro = new ResizeObserver(() => {
      const nw = Math.floor(box.clientWidth);
      if (nw) setW((old) => (old === nw ? old : nw));
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** `<div class="chart-box">` that renders `children(width)` once its width is known, and on resize. */
export function ChartBox({
  children,
  className = 'chart-box',
}: {
  children: (width: number) => ReactNode;
  className?: string;
}) {
  const [ref, w] = useWidth();
  return (
    <div ref={ref} className={className}>
      {w ? children(w) : null}
    </div>
  );
}

/** Unique id for SVG <defs> (gradients) per chart instance. */
export const useSvgId = (prefix: string): string => `${prefix}${useId().replace(/:/g, '')}`;

export function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= step0) || step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(v);
  return out;
}

export interface DonutSeg {
  label: string;
  value: number;
  tone: string;
  onClick?: () => void;
}

/**
 * Donut with an interactive legend: hovering a slice or a legend row shows it in the centre.
 * `fmt` formats the centre value and the legend values (counts by default).
 */
export function Donut({
  segs,
  size = 156,
  totalLabel = 'total',
  fmt = fmtInt,
}: {
  segs: DonutSeg[];
  size?: number;
  totalLabel?: string;
  fmt?: (n: number) => string;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  const total = segs.reduce((a, s) => a + (s.value || 0), 0);
  const sw = 16,
    r = (size - sw) / 2,
    C = 2 * Math.PI * r;
  let acc = 0;
  const arcs = segs.map((s) => {
    const len = total ? (s.value / total) * C : 0;
    const arc = { len, gapLen: len > 4 ? 2 : 0, offset: -acc };
    acc += len;
    return arc;
  });
  const focused = focus === null ? null : segs[focus];
  return (
    <div className="donut-wrap">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="donut"
        role="img"
        aria-label={segs.map((s) => `${s.label} ${s.value}`).join(', ')}
      >
        <circle className="donut-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={sw} />
        {segs.map((s, i) => (
          <circle
            key={i}
            className={`donut-seg ${s.tone}${focus !== null && focus !== i ? ' dim' : ''}`}
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={sw}
            strokeDasharray={`${Math.max(0, arcs[i]!.len - arcs[i]!.gapLen)} ${C}`}
            strokeDashoffset={arcs[i]!.offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            onPointerEnter={() => setFocus(i)}
            onPointerLeave={() => setFocus(null)}
          />
        ))}
        <text className="donut-value" x={size / 2} y={size / 2 + 2} textAnchor="middle">
          {focused ? fmt(focused.value) : fmt(total)}
        </text>
        <text className="donut-label" x={size / 2} y={size / 2 + 20} textAnchor="middle">
          {focused ? `${total ? Math.round((focused.value / total) * 100) : 0}%` : totalLabel}
        </text>
      </svg>
      <ul className="legend">
        {segs.map((s, i) => (
          <li
            key={i}
            tabIndex={0}
            className={
              [s.onClick ? 'clickable' : '', focus === i ? 'on' : ''].join(' ').trim() || undefined
            }
            onPointerEnter={() => setFocus(i)}
            onPointerLeave={() => setFocus(null)}
            onFocus={() => setFocus(i)}
            onBlur={() => setFocus(null)}
            onClick={s.onClick}
          >
            <span className={`swatch ${s.tone}`} aria-hidden="true" />
            <span className="legend-label">{s.label}</span>
            <b>{fmt(s.value)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface HBarItem {
  label: ReactNode;
  value: number;
  tone?: string;
  title?: string;
}

/** Horizontal bars (HTML) with the value at the end. */
export function HBars({
  items,
  tone,
  fmt = fmtInt,
  empty,
}: {
  items: HBarItem[];
  tone?: string;
  fmt?: (n: number) => string;
  empty?: ReactNode;
}) {
  if (!items.length) return <div className="empty">{empty || 'Nothing to show.'}</div>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="hbars">
      {items.map((it, i) => (
        <div key={i} className="hbar" title={it.title}>
          <span className="hbar-label">{it.label}</span>
          <span className="hbar-track">
            <i
              className={it.tone || tone || 'base'}
              style={{ width: `${Math.max(1.5, (it.value / max) * 100)}%` }}
            />
          </span>
          <b>{fmt(it.value)}</b>
        </div>
      ))}
    </div>
  );
}

/** Progress ring (SVG); `fraction` 0–1, `tone` adds a class to the arc (base, violet, …). */
export function Ring({ size, fraction, tone }: { size: number; fraction: number; tone?: string }) {
  const sw = 10,
    r = (size - sw) / 2,
    C = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction || 0));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="ring"
      aria-hidden="true"
    >
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={sw} />
      <circle
        className={`ring-arc ${tone || ''}`}
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={sw}
        strokeDasharray={C}
        strokeDashoffset={String(C * (1 - f))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

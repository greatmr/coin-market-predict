// Overview-only charts: the screen funnel and stacked rows.
import { useSvgId } from '../../components/charts';
import { fmtInt } from '../../lib/format';

import type { StackSeg } from './types';

const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One horizontal stacked bar (the `.stack-bar` span). */
export function StackBar({ segs }: { segs: StackSeg[] }) {
  const total = segs.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <span className="stack-bar">
      {segs.map((s, i) => (
        <i
          key={i}
          className={s.tone}
          title={`${s.label}: ${fmtInt(s.value)}`}
          style={{ width: `${(s.value / total) * 100}%` }}
        />
      ))}
    </span>
  );
}

/** One horizontal stacked bar per row. */
export function StackRows({ rows }: { rows: { label: string; segs: StackSeg[] }[] }) {
  return (
    <div className="stacks">
      {rows.map((row, ri) => (
        <div key={ri} className="stack-row">
          <span className="stack-label">{row.label}</span>
          <StackBar segs={row.segs} />
          <span className="stack-nums">
            {row.segs.map((s, i) => (
              <span key={i} className={s.tone}>
                {fmtInt(s.value)}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface FunnelStage {
  label: string;
  value: number;
  sub: string;
}

/** The screen as a narrowing band: widths use a square-root scale so 8,000 and 26 both stay visible. */
export function Funnel({ W, stages }: { W: number; stages: FunnelStage[] }) {
  const gid = useSvgId('fun');
  if (W < 560) return <FunnelStacked W={W} stages={stages} gid={gid} />;
  const H = 210;
  const m = { l: 4, r: 4, t: 54, b: 34 };
  const n = stages.length;
  const max = Math.max(...stages.map((s) => s.value), 1);
  const cy = m.t + (H - m.t - m.b) / 2;
  const hMax = H - m.t - m.b;
  const xs = stages.map((_, i) => m.l + (i * (W - m.l - m.r)) / (n - 1));
  const hs = stages.map((s) => Math.max(4, Math.sqrt(s.value / max) * hMax));
  const x = (i: number) => xs[i]!;
  const h = (i: number) => hs[i]!;
  let top = `M${x(0)},${cy - h(0) / 2}`;
  for (let i = 1; i < n; i++) {
    const mx = (x(i - 1) + x(i)) / 2;
    top += `C${mx},${cy - h(i - 1) / 2} ${mx},${cy - h(i) / 2} ${x(i)},${cy - h(i) / 2}`;
  }
  let bot = `L${x(n - 1)},${cy + h(n - 1) / 2}`;
  for (let i = n - 1; i > 0; i--) {
    const mx = (x(i - 1) + x(i)) / 2;
    bot += `C${mx},${cy + h(i) / 2} ${mx},${cy + h(i - 1) / 2} ${x(i - 1)},${cy + h(i - 1) / 2}`;
  }
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="funnel"
      role="img"
      aria-label={stages.map((s) => `${s.label}: ${s.value}`).join(', ')}
    >
      <defs>
        <linearGradient id={gid} x1={0} y1={0} x2={1} y2={0}>
          <stop offset="0%" className="fun-a" />
          <stop offset="70%" className="fun-b" />
          <stop offset="100%" className="fun-c" />
        </linearGradient>
      </defs>
      <path
        className={`funnel-shape${reduceMotion ? '' : ' draw'}`}
        d={`${top}${bot}Z`}
        fill={`url(#${gid})`}
      />
      {stages.map((s, i) => {
        const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
        return (
          <g key={i}>
            <line className="funnel-guide" x1={x(i)} x2={x(i)} y1={m.t - 8} y2={H - m.b + 8} />
            <text
              className={`funnel-value${i === n - 1 ? ' surge' : ''}`}
              x={x(i)}
              y={30}
              textAnchor={anchor}
            >
              {fmtInt(s.value)}
            </text>
            <text className="funnel-label" x={x(i)} y={46} textAnchor={anchor}>
              {s.label}
            </text>
            {s.sub ? (
              <text className="funnel-sub" x={x(i)} y={H - 10} textAnchor={anchor}>
                {s.sub}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Narrow screens: the same stages as stacked bars, so labels never collide. */
function FunnelStacked({ W, stages, gid }: { W: number; stages: FunnelStage[]; gid: string }) {
  const rowH = 52;
  const H = stages.length * rowH;
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="funnel"
      role="img"
      aria-label={stages.map((s) => `${s.label}: ${s.value}`).join(', ')}
    >
      <defs>
        <linearGradient id={gid} x1={0} y1={0} x2={1} y2={0}>
          <stop offset="0%" className="fun-a" />
          <stop offset="100%" className="fun-b" />
        </linearGradient>
      </defs>
      {stages.map((s, i) => {
        const y = i * rowH;
        const last = i === stages.length - 1;
        return (
          <g key={i}>
            <text className={`funnel-value${last ? ' surge' : ''}`} x={0} y={y + 22}>
              {fmtInt(s.value)}
            </text>
            <text className="funnel-label" x={W} y={y + 22} textAnchor="end">
              {s.label}
            </text>
            <rect
              className={`funnel-shape${last ? ' surge-fill' : ''}${reduceMotion ? '' : ' draw'}`}
              x={0}
              y={y + 30}
              width={Math.max(6, Math.sqrt(s.value / max) * W)}
              height={10}
              rx={5}
              fill={`url(#${gid})`}
            />
          </g>
        );
      })}
    </svg>
  );
}

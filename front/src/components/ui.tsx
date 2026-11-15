// Shared building blocks. Source text (coin names, symbols, notes) is rendered as React text, never
// as HTML, because it comes from external sources or reviewers.
import { type KeyboardEvent, type MouseEvent, type ReactNode, useState } from 'react';

import { type StatusMap, type Tone, multPos, reasonText } from '../lib/constants';
import { fmtInt, fmtMult, isNum, num } from '../lib/format';
import { useApp } from '../state/app';
import type { Num } from '../types/api';

export const StatusLabel = ({
  dot,
  text,
  title,
}: {
  dot?: Tone | string;
  text: ReactNode;
  title?: string;
}) => (
  <span className="status" title={title}>
    <span className={`dot ${dot || ''}`} aria-hidden="true" />
    {text}
  </span>
);

/** A status from one of the vocabularies in lib/constants.ts (ELIG, LBANK, RUN, …). */
export const Lab = ({
  map,
  k,
  title,
}: {
  map: StatusMap;
  k: string | null | undefined;
  title?: string;
}) => (
  <StatusLabel dot={(k && map[k]?.[0]) || ''} text={(k && map[k]?.[1]) || k || '—'} title={title} />
);

export const Chip = ({
  children,
  strong,
  tone,
  title,
  dot,
}: {
  children: ReactNode;
  strong?: boolean;
  tone?: string;
  title?: string;
  dot?: string;
}) => (
  <span className={`chip${strong ? ' strong' : ''}${tone ? ` ${tone}` : ''}`} title={title}>
    {dot ? <span className={`dot ${dot}`} aria-hidden="true" /> : null}
    {children}
  </span>
);

/** Definition list from [label, value] pairs; falsy pairs are skipped. */
export const Kv = ({
  pairs,
}: {
  pairs: (readonly [ReactNode, ReactNode] | false | null | undefined)[];
}) => (
  <dl className="kv">
    {pairs
      .filter((p): p is readonly [ReactNode, ReactNode] => !!p)
      .map(([k, v], i) => (
        <div key={typeof k === 'string' ? k : i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
  </dl>
);

export interface Column<R> {
  label: ReactNode;
  num?: boolean;
  title?: string;
  render: (row: R) => ReactNode;
}

const INTERACTIVE = 'button, a, input, select, textarea';

/**
 * A table. With `onRow(row, trElement)`, rows are clickable and open with Enter (clicks on buttons,
 * links and inputs inside a row are left to them).
 */
export function Table<R>({
  cols,
  rows,
  empty,
  onRow,
  rowKey,
  rowClass,
}: {
  cols: Column<R>[];
  rows: R[] | null | undefined;
  empty?: ReactNode;
  onRow?: (row: R, tr: HTMLTableRowElement) => void;
  rowKey?: (row: R, index: number) => string | number;
  rowClass?: (row: R) => string;
}) {
  if (!rows || !rows.length) return <div className="empty">{empty || 'Nothing to show.'}</div>;
  const click = (r: R) => (e: MouseEvent<HTMLTableRowElement>) => {
    if (onRow && !(e.target as Element).closest(INTERACTIVE)) onRow(r, e.currentTarget);
  };
  const key = (r: R) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (onRow && e.key === 'Enter' && !(e.target as Element).closest(INTERACTIVE))
      onRow(r, e.currentTarget);
  };
  return (
    <table>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={i} className={c.num ? 'num' : undefined} title={c.title} scope="col">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => {
          const cls =
            [onRow ? 'clickable' : '', rowClass ? rowClass(r) : ''].filter(Boolean).join(' ') ||
            undefined;
          return (
            <tr
              key={rowKey ? rowKey(r, ri) : ri}
              className={cls}
              tabIndex={onRow ? 0 : undefined}
              onClick={onRow ? click(r) : undefined}
              onKeyDown={onRow ? key(r) : undefined}
            >
              {cols.map((c, ci) => (
                <td key={ci} className={c.num ? 'num' : undefined}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
  unit = 'coins',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  unit?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <>
      <span>
        {fmtInt(total)} {unit}, page {page + 1} of {pages}
      </span>
      <button type="button" className="btn" disabled={page === 0} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <button
        type="button"
        className="btn"
        disabled={page + 1 >= pages}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </>
  );
}

export const Stars = ({ n }: { n: number }) => (
  <span className={`stars s${n}`} title={`${n} of 3 windows met`} aria-label={`${n} of 3 stars`}>
    {'★'.repeat(n)}
    <span className="off" aria-hidden="true">
      {'★'.repeat(Math.max(0, 3 - n))}
    </span>
  </span>
);

/** CMC logo for live coins; a placeholder for synthetic ids (≥ 900000) or when the image fails. */
export function Logo({ cmcId, size = 22 }: { cmcId: number; size?: number }) {
  const { live } = useApp();
  const [failed, setFailed] = useState(false);
  if (failed || !(live && Number.isInteger(cmcId) && cmcId < 900000))
    return <span className="logo ph" aria-hidden="true" />;
  return (
    <img
      className="logo"
      src={`https://s2.coinmarketcap.com/static/img/coins/64x64/${cmcId}.png`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export const CoinCell = ({ r }: { r: { cmcId: number; symbol: string; name: string } }) => (
  <div className="coin">
    <Logo cmcId={r.cmcId} />
    <div className="coin-text">
      <b>{r.symbol}</b>
      <span title={r.name}>{r.name}</span>
    </div>
  </div>
);

/** The multiple as a bar on a log scale, with the pass line (1.5×) marked. */
export function MultBar({ m, status }: { m: number | null; status: string | null | undefined }) {
  const { passLine } = useApp();
  return (
    <span className={`mbar ${status === 'YES' ? 'yes' : 'no'}`} aria-hidden="true">
      <i style={{ width: `${(multPos(m) * 100).toFixed(1)}%` }} />
      <s style={{ left: `${(multPos(passLine) * 100).toFixed(1)}%` }} />
    </span>
  );
}

/** YES / NO / N/A with the multiple as a bar against the 1.5× line, and the N/A reason as a tooltip. */
export function PassCell({
  status,
  multiple,
  reason,
}: {
  status: string | null | undefined;
  multiple: Num | null | undefined;
  reason?: string | null;
}) {
  if (status === 'N/A' || status === null || status === undefined)
    return (
      <span className="pass na" title={reasonText(reason) || 'not available'}>
        N/A
      </span>
    );
  const m = num(multiple);
  return (
    <span
      className={`pass ${status === 'YES' ? 'yes' : 'no'}`}
      title={`${status}: current ÷ mean = ${isNum(m) ? m.toFixed(4) : '?'}`}
    >
      <b>{fmtMult(m)}</b>
      <MultBar m={m} status={status} />
    </span>
  );
}

/** Weighted points (weighted_star_v1): a lower bound when a window is N/A; strength in the tooltip. */
export function PointsCell({
  points,
  complete,
  strength,
}: {
  points: number | null | undefined;
  complete: boolean | null | undefined;
  strength?: Num | null;
}) {
  if (points === null || points === undefined) return <span className="muted">—</span>;
  const s = num(strength);
  return (
    <span
      className={complete ? 'pts' : 'pts lower'}
      title={`${complete ? 'Weighted points' : 'Confirmed lower bound: a window is N/A'} (3d 60 · 7d 25 · 30d 15 per YES)${isNum(s) ? `; strength ${s.toFixed(2)}` : ''}`}
    >
      {`${complete ? '' : '≥ '}${points}`}
    </span>
  );
}

/** Inline load error in the box that failed. */
export const LoadError = ({ error }: { error: unknown }) =>
  error ? (
    <div className="error">
      Could not load: {error instanceof Error ? error.message : String(error)}
    </div>
  ) : null;

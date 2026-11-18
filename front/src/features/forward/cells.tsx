// Cells of the forward-test event table, its sortable headers and the two explanation dialogs
// (overlapping events, an unconfirmed identification-day High). Display only: every number arrives
// computed from the API.
import { useEffect, useState } from 'react';

import { Chip, Lab, Stars, StatusLabel } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { infoDialog } from '../../lib/feedback';
import { fmtAgo, fmtDay, fmtMult, fmtPct, fmtPrice, fmtTime, tz, utc } from '../../lib/format';

import {
  BITHUMB_TEXT,
  CHECK,
  DAY0_EXPLAINED,
  DAY0_FLAGS,
  FWD_STATUS,
  LISTED,
  LISTING_REASON,
  OVERLAP_EXPLAINED,
  SORT_LABEL,
  flagText,
} from './labels';
import type {
  CoinAverageReturn,
  EventSort,
  ForwardEventRow,
  ForwardOverlaps,
  Listing,
  PassStatus,
} from './types';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The coin's Average Return in words, e.g. "Average Return ≥ +12.3% over the 3 events with a
 * Return (2 not final: a lower bound, not a final result)".
 */
export function coinAverageText(c: CoinAverageReturn): string {
  if (c.averagePct === null) return 'no event has a Return yet, so there is no Average Return';
  const lower = c.lowerBounds > 0;
  return `Average Return ${lower ? '≥ ' : ''}${fmtPct(c.averagePct)} over the ${plural(c.withReturn, 'event')} with a Return${
    lower ? ` (${c.lowerBounds} not final: a lower bound, not a final result)` : ' (all final)'
  }`;
}

/**
 * Average Return of the row's coin over all its stored events. Marked ≥ (like a so-far Return)
 * while any Return in it is a lower bound; never called profit.
 */
export function CoinAverageCell({ r }: { r: ForwardEventRow }) {
  const c = r.coinAverageReturn;
  const lower = c.lowerBounds > 0;
  const title = [
    `${r.symbol} (CMC id ${r.cmcId}): ${coinAverageText(c)}, out of ${plural(c.events, 'stored event')} of any status and star count.`,
    'Events without a Return are left out, never counted as 0 %.',
    lower
      ? `${c.lowerBounds} of the averaged Returns are so far or lower bounds (window open, final day pending or a day missing): the average can still rise.`
      : '',
    'A peak return (highest High after identification ÷ identification price − 1), not trading profit; the events of one coin follow one price path.',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="fwd-avg" title={title}>
      {c.averagePct === null ? (
        <span className="muted">—</span>
      ) : (
        <b className={lower ? 'fwd-ret provisional' : 'fwd-ret'}>
          {`${lower ? '≥ ' : ''}${fmtPct(c.averagePct)}`}
        </b>
      )}
      <span className="muted small">{`${c.withReturn} of ${plural(c.events, 'event')} with a Return`}</span>
      {c.averagePct === null ? null : (
        <span className={lower ? 'fwd-avg-note lower small' : 'fwd-avg-note small'}>
          {lower ? `lower bound · ${c.lowerBounds} not final` : 'all final'}
        </span>
      )}
    </div>
  );
}

/** Hover text of one listing: the pairs and the list's fetch time, or why it is Unknown. */
function listingTitle(label: string, l: Listing): string {
  const when = l.listFetchedAt
    ? ` (list fetched ${fmtTime(l.listFetchedAt)}, ${utc(l.listFetchedAt)})`
    : '';
  if (l.status === 'YES') return `${label}: listed as ${l.pairs.join(', ')}${when}.`;
  if (l.status === 'NO') return `${label}: not in the list, matched by CMC id${when}.`;
  return `${label}: Unknown, ${(l.reason && LISTING_REASON[l.reason]) || l.reason || 'not verified'}. Not verified, so not shown as No.`;
}

/** LBank Spot and Futures listing of the coin now, each from its own list. */
export function LbankMarketsCell({ r }: { r: ForwardEventRow }) {
  const rows: [string, Listing][] = [
    ['Spot', r.exchanges.lbankSpot],
    ['Futures', r.exchanges.lbankFutures],
  ];
  return (
    <div className="fwd-avail">
      {rows.map(([label, l]) => (
        <span key={label} className="fwd-avail-row" title={listingTitle(`LBank ${label}`, l)}>
          <span className="muted">{label}</span>
          <b className={`fwd-listed ${LISTED[l.status][0]}`}>{LISTED[l.status][1]}</b>
        </span>
      ))}
    </div>
  );
}

export function BithumbCell({ r }: { r: ForwardEventRow }) {
  const b = r.exchanges.bithumb;
  return (
    <b className={`fwd-listed ${LISTED[b.status][0]}`} title={listingTitle('Bithumb', b)}>
      {BITHUMB_TEXT[b.status]}
    </b>
  );
}

const day0Unconfirmed = (r: ForwardEventRow) => r.qualityFlags.some((f) => DAY0_FLAGS.has(f));

/** Why the identification day's High is not counted, in the words of the event's own times. */
function day0Reason(r: ForwardEventRow): string {
  const d = r.day0;
  if (!d?.timeHigh)
    return 'It is unknown whether this high occurred before or after identification.';
  return `CMC dates this High at ${fmtTime(d.timeHigh)}, before identification at ${fmtTime(r.detectedAt)} (${tz()}). The highest price after identification on that day is unknown from daily data.`;
}

export function openDay0(r: ForwardEventRow) {
  const d = r.day0;
  void infoDialog(
    `${r.symbol}: identification-day High not confirmed`,
    <div className="fwd-explain">
      <p className="fwd-day0-text">{day0Reason(r)}</p>
      {d?.highUsd ? (
        <p>
          {`Day 0 (${fmtDay(r.detectedUtcDate)} UTC) High ${fmtPrice(d.highUsd)} against the identification price ${fmtPrice(r.referencePriceUsd)}`}
          {d.changePct ? ` would be ${fmtPct(d.changePct)}` : ''}
          {' if it had come after identification. It is not counted.'}
        </p>
      ) : null}
      <p className="muted small">{DAY0_EXPLAINED}</p>
    </div>,
  );
}

/** The table of the same coin's overlapping events, loaded when the dialog opens. */
function OverlapList({ eventId }: { eventId: string }) {
  const [data, setData] = useState<ForwardOverlaps | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<ForwardOverlaps>(`forward/events/${eventId}/overlaps`).then(setData, (e: unknown) =>
      setError(errorMessage(e)),
    );
  }, [eventId]);
  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <p className="muted small">Loading…</p>;
  const e = data.event;
  const relation = (x: ForwardOverlaps['overlaps'][number]) =>
    x.relation === 'same_utc_day'
      ? `Same UTC day, ${x.starCount === e.starCount ? 'same' : 'different'} star count: its own event`
      : x.relation === 'earlier'
        ? 'Identified earlier; its window was still open'
        : 'Identified later, inside this window';
  const c = data.coin;
  return (
    <div className="fwd-explain">
      <p>
        {`This event: ${e.symbol} ${e.starCount}★, identified ${fmtTime(e.detectedAt)} at ${fmtPrice(e.referencePriceUsd)}, window to ${fmtTime(e.evaluationEnd)}.`}
      </p>
      <p className="fwd-coin-avg">
        {`All ${plural(c.events, 'stored event')} of ${e.symbol} (CMC id ${c.cmcId}): ${coinAverageText(c)}. Events without a Return are left out, never counted as 0 %. The table below lists only the ${plural(data.overlaps.length, 'event')} whose windows overlap this one.`}
      </p>
      <p className="muted small">{OVERLAP_EXPLAINED}</p>
      {data.overlaps.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Coin</th>
                <th scope="col">Stars</th>
                <th scope="col">Identified</th>
                <th scope="col" className="num">
                  Price at identification
                </th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Return
                </th>
                <th scope="col">Why it overlaps</th>
              </tr>
            </thead>
            <tbody>
              {data.overlaps.map((x) => (
                <tr key={x.eventId}>
                  <td>{`${x.symbol} · ${x.name}`}</td>
                  <td>
                    <Stars n={x.starCount} />
                  </td>
                  <td title={utc(x.detectedAt)}>{fmtTime(x.detectedAt)}</td>
                  <td className="num">{fmtPrice(x.referencePriceUsd)}</td>
                  <td>
                    <Lab map={FWD_STATUS} k={x.status} />
                  </td>
                  <td className="num">
                    {x.peakReturnPct === null
                      ? '—'
                      : `${x.peakKind === 'EXACT' ? '' : '≥ '}${fmtPct(x.peakReturnPct)}`}
                  </td>
                  <td className="wrap">
                    {`${relation(x)}. Shared window ${fmtTime(x.overlapStart)} – ${fmtTime(x.overlapEnd)} (${Math.round(Number(x.overlapHours))} h).`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No overlapping events.</p>
      )}
    </div>
  );
}

export const openOverlaps = (r: ForwardEventRow) =>
  void infoDialog(
    `${r.symbol}: ${r.overlappingEventIds.length} overlapping events`,
    <OverlapList eventId={r.eventId} />,
    { wide: true },
  );

export function FwdPeak({ r }: { r: ForwardEventRow }) {
  const o = r.outcome;
  const unconfirmed = day0Unconfirmed(r) && r.day0?.highUsd;
  if ((!o || !o.peakHighUsd) && !unconfirmed) return <span className="muted">—</span>;
  return (
    <div className="fwd-peak">
      {o?.peakHighUsd ? (
        <>
          <b>{fmtPrice(o.peakHighUsd)}</b>
          <span
            className="muted small"
            title={
              o.peakTimePrecision === 'UTC_DAY'
                ? 'Only the UTC day of this High is known.'
                : `When the price reached this High, as published by CMC (timeHigh), shown in ${tz()}. Not the time it was retrieved or checked.`
            }
          >
            {o.peakAt
              ? `at ${fmtTime(o.peakAt)}`
              : `${o.peakDate ? fmtDay(o.peakDate) : '—'} UTC, time unknown`}
          </span>
          {o.extensionPeakFlag === 'TRUE' ? (
            <Chip title="Inside the end-of-day extension after 168 h.">after 168 h</Chip>
          ) : o.extensionPeakFlag === 'UNKNOWN' ? (
            <Chip title="The time precision cannot show whether this came after 168 h.">
              168 h?
            </Chip>
          ) : null}
        </>
      ) : null}
      {unconfirmed ? (
        <button
          type="button"
          className="fwd-day0"
          title={`${day0Reason(r)} Not counted in Return or any statistic.`}
          onClick={() => openDay0(r)}
        >
          {`Day 0 High ${fmtPrice(r.day0!.highUsd)}`}
          <i aria-hidden="true">?</i>
        </button>
      ) : null}
    </div>
  );
}

export function FwdReturn({ r }: { r: ForwardEventRow }) {
  const o = r.outcome;
  if (o && o.peakReturnPct !== null) {
    const exact = o.peakKind === 'EXACT';
    return (
      <span
        className={exact ? 'fwd-ret' : 'fwd-ret provisional'}
        title={
          exact
            ? 'Final peak return: the highest confirmed High after identification ÷ the identification price − 1.'
            : 'So far (lower bound): the window is still open, the final day is pending or a day is not covered.'
        }
      >
        {`${exact ? '' : '≥ '}${fmtPct(o.peakReturnPct)}`}
      </span>
    );
  }
  const [text, cls, title] =
    r.check.status === 'NOT_CHECKED'
      ? ['not checked yet', 'muted small', CHECK.NOT_CHECKED[2]]
      : day0Unconfirmed(r)
        ? [
            'unconfirmed',
            'fwd-day0-text small',
            'Only the identification-day High exists so far, and it is not proven to come after identification.',
          ]
        : r.check.status === 'DATA_UNAVAILABLE' || r.check.status === 'RETRIEVAL_ERROR'
          ? ['no data', 'muted small', CHECK[r.check.status][2]]
          : ['—', 'muted', 'No confirmed High after identification yet.'];
  return (
    <span className={cls} title={title}>
      {text}
    </span>
  );
}

export function CheckCell({ r }: { r: ForwardEventRow }) {
  const c = r.check;
  const [tone, label, help] = CHECK[c.status];
  const failedLater =
    c.lastCheckAt && c.lastSuccessAt && new Date(c.lastCheckAt) > new Date(c.lastSuccessAt);
  const sub =
    c.status === 'NOT_CHECKED'
      ? r.window.closedDays === 0
        ? 'first check after day 0 ends (00:00 UTC)'
        : 'waiting for the daily check'
      : `through ${c.checkedThrough ? `${fmtDay(c.checkedThrough)} UTC` : '— (day 0 missing)'} · ${fmtAgo(c.lastSuccessAt ?? c.lastCheckAt)}`;
  const title = [
    help,
    c.note,
    c.lastSuccessAt
      ? `Last successful check: ${fmtTime(c.lastSuccessAt)} (${utc(c.lastSuccessAt)}).`
      : '',
    failedLater && c.lastCheckAt ? `Last attempt (failed): ${fmtTime(c.lastCheckAt)}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="fwd-check" title={title}>
      <StatusLabel dot={tone} text={label} />
      <span className="muted small">{sub}</span>
    </div>
  );
}

export function WindowCell({ r }: { r: ForwardEventRow }) {
  const w = r.window;
  return (
    <div
      className="fwd-window"
      title={`Days are UTC calendar days: day 0 = ${fmtDay(r.detectedUtcDate)} (UTC date of identification), day ${w.lastDay} = the UTC date of identification + 168 h (${utc(r.deadline168h)}), included to ${utc(r.evaluationEnd)}. ${Number(r.effectiveHorizonHours).toFixed(1)} h in all.`}
    >
      <b>{w.closed ? 'Window closed' : `Day ${w.day} of ${w.lastDay}`}</b>
      <span className="muted small">
        {`${w.checkedDays} of ${w.closedDays} closed ${w.closedDays === 1 ? 'day' : 'days'} checked`}
      </span>
      <span className="muted small">{`ends ${fmtTime(r.evaluationEnd)}`}</span>
    </div>
  );
}

/** The scanner's 3d / 7d / 30d results recorded at identification (multiples, YES in colour). */
export function FwdWindows({ r }: { r: ForwardEventRow }) {
  const windows: [string, PassStatus, string | null][] = [
    ['3d', r.pass3d, r.multiple3d],
    ['7d', r.pass7d, r.multiple7d],
    ['30d', r.pass30d, r.multiple30d],
  ];
  return (
    <span className="fwd-windows">
      {windows.map(([d, status, m]) => (
        <span
          key={d}
          className={`pass ${status === 'YES' ? 'yes' : status === 'NO' ? 'no' : 'na'}`}
          title={`${d} at identification: ${status}${m ? ` (current VMC ÷ ${d} mean = ${fmtMult(m)})` : ''}. Recorded once, never updated.`}
        >
          <b>{status === 'N/A' ? 'N/A' : fmtMult(m)}</b>
        </span>
      ))}
    </span>
  );
}

export function NotesCell({ r }: { r: ForwardEventRow }) {
  return (
    <span className="chips">
      {r.qualityFlags.map((f) =>
        DAY0_FLAGS.has(f) ? (
          <button
            key={f}
            type="button"
            className="chip fwd-day0-chip"
            title="What does this mean? Click for the explanation."
            onClick={() => openDay0(r)}
          >
            {flagText(f)}
          </button>
        ) : (
          <Chip key={f} tone={/^(INCOMPLETE|HIGH_)/.test(f) ? 'warn' : undefined} title={f}>
            {flagText(f)}
          </Chip>
        ),
      )}
      {r.overlappingEventIds.length ? (
        <button
          type="button"
          className="chip link-chip"
          title="Other events of this coin whose windows overlap this one (this row not included). Click for the list."
          onClick={() => openOverlaps(r)}
        >
          {`${r.overlappingEventIds.length} overlapping`}
        </button>
      ) : null}
    </span>
  );
}

/** A column header that sorts the list; a second click reverses the direction. */
export function SortHead({
  k,
  label,
  sort,
  dir,
  onSort,
}: {
  k: EventSort;
  label: string;
  sort: EventSort;
  dir: 'asc' | 'desc';
  onSort: (k: EventSort) => void;
}) {
  const on = sort === k;
  return (
    <button
      type="button"
      className={`sort-btn${on ? ' on' : ''}`}
      aria-label={`Sort by ${SORT_LABEL[k]}${on ? (dir === 'desc' ? ', now highest first' : ', now lowest first; click again to clear the sort') : ''}`}
      title={on && dir === 'asc' ? 'Click again to clear the sort' : undefined}
      onClick={() => onSort(k)}
    >
      {label}
      <i aria-hidden="true">{on ? (dir === 'desc' ? '↓' : '↑') : '↕'}</i>
    </button>
  );
}

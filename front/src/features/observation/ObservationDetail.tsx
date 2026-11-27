// Everything behind one observation (GET /api/observations/:id), both venues kept apart: a short
// summary (one card per venue) and named sections that open on demand — the timing chain from the
// CMC crawl to this page, the Spot reference trade, the verified Spot extremes, the sampled Futures
// side, coverage and gaps, pair / contract mapping and listing evidence, review flags, rules versions
// with results and audit history, and the raw identifiers. Nothing is hidden or dropped: sections
// are folded, not removed. Loaded when the dialog opens.
import { type ReactNode, useEffect, useState } from 'react';

import { Kv, Lab, Stars } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { humanize } from '../../lib/constants';
import { infoDialog } from '../../lib/feedback';
import { fmtClock, fmtExact, fmtPct, fmtPrice, fmtTime, tz } from '../../lib/format';

import { onObservationChange } from './changes';
import {
  ELIGIBILITY,
  FLAG,
  FUTURES_QUOTE_LABEL,
  FUTURES_TEXT,
  FUT_EVIDENCE,
  FUT_STATUS,
  FUT_STATUS_TEXT,
  GAP_TEXT,
  LISTING_TEXT,
  MAPPING_TEXT,
  ORDER,
  QUOTE_SOURCE_TEXT,
  STATUS,
  TIME_BASIS,
  TIMING_TEXT,
  TRADING_TEXT,
  delayText,
  diffText,
  obsReasonText,
  spanText,
} from './labels';
import type { ExtremeEvidence, ObservationDetail, ObservationRow, Timeline } from './types';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const ms = (a: string | null | undefined, b: string | null | undefined) =>
  a && b ? Date.parse(b) - Date.parse(a) : null;

const Section = ({
  title,
  hint,
  open,
  children,
}: {
  title: string;
  hint?: string;
  open?: boolean;
  children: ReactNode;
}) => (
  <details className="obs-sec" open={open || undefined}>
    <summary>
      <span>{title}</span>
      {hint ? <span className="muted small">{hint}</span> : null}
    </summary>
    <div className="obs-sec-body">{children}</div>
  </details>
);

/** Why an extreme is not proven for the whole window yet (an open window is not a defect). */
function provenText(ev: ExtremeEvidence): string {
  if (ev.proven) return 'yes: no other minute of the window could hold a more extreme price';
  const open = ev.blocking.filter(
    (b) => b.kind === 'gap' && (b.state === 'FUTURE' || b.state === 'NOT_FETCHED'),
  );
  // Categories, not counts: the stored list is capped at 25 entries.
  const checks = ev.blocking.some((b) => b.kind === 'check');
  const gaps =
    ev.blocking.length > open.length + ev.blocking.filter((b) => b.kind === 'check').length;
  const parts: string[] = [];
  if (checks) parts.push('candidate minutes whose trades are not verified yet');
  if (gaps) parts.push('gaps being retried (see Coverage)');
  if (open.length) {
    // The window's last (boundary) minute is listed first: name the earliest open minute.
    const from = fmtExact(
      open.map((b) => b.from).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!,
    );
    parts.push(
      checks || gaps
        ? `minutes from ${from} on are not fetched yet`
        : `the window is still running: every minute before ${from} is settled, later ones are not fetched yet`,
    );
  }
  return `not yet: ${parts.join('; ') || 'pending'}`;
}

function Extreme({
  label,
  ev,
  pct,
}: {
  label: string;
  ev: ExtremeEvidence | null;
  pct: string | null;
}) {
  if (!ev?.best) return <p className="muted small">{`${label}: none yet.`}</p>;
  return (
    <div>
      <Kv
        pairs={[
          [label, `${fmtPrice(ev.best.price)} (${pct === null ? '—' : fmtPct(pct)} vs reference)`],
          ['Trade time', fmtExact(ev.best.time)],
          ['Trade id', <code key="i">{ev.best.id}</code>],
          ['Quantity', ev.best.qty],
          ['Proven for the whole window', provenText(ev)],
        ]}
      />
      {ev.checked.length ? (
        <p className="muted small">
          {`Candidate minutes checked trade by trade (candle bound → real trade): ${ev.checked
            .map(
              (c) =>
                `${fmtExact(c.minute).slice(11, 16)} ${c.candle}→${c.traded ?? c.check.toLowerCase()}`,
            )
            .join(', ')}`}
        </p>
      ) : null}
      {ev.blocking.length ? (
        <p className="muted small">
          {`Still open: ${ev.blocking
            .slice(0, 6)
            .map((b) => `${fmtExact(b.from)}–${fmtExact(b.to)} ${humanize(b.state).toLowerCase()}`)
            .join('; ')}`}
        </p>
      ) : null}
    </div>
  );
}

/** The chain from the CMC crawl to this dialog: three different delays, never one number. */
function TimingChain({ d, loadedAt }: { d: ObservationDetail; loadedAt: number }) {
  const t: Timeline = d.timeline;
  const stages = t.pipelineStages.filter((s) => s.durationMs !== null);
  const slowest = stages.reduce<(typeof stages)[number] | null>(
    (a, s) => (!a || (s.durationMs ?? 0) > (a.durationMs ?? 0) ? s : a),
    null,
  );
  const c = t.referenceCheck;
  const steps: Array<[string, string | null, ReactNode]> = [
    ['CMC crawl (names the event)', t.crawlAt, null],
    [
      'Review Queue published = window start',
      t.publishedAt,
      t.publishedAt
        ? `${spanText(ms(t.crawlAt, t.publishedAt)!)} after the crawl`
        : 'not proven yet',
    ],
    ['Event committed (observation created)', t.eventCommittedAt, null],
    [
      'Start minute closed (its trades checkable)',
      t.startMinuteReadableAt,
      'a minute’s trade list is verified against its final candle',
    ],
    [
      'Reference trade',
      t.referenceTradeAt,
      t.marketDelayMs !== null
        ? `market delay ${delayText(t.marketDelayMs)} after the start`
        : null,
    ],
    [
      'Verified by the observation job',
      c?.checkedAt ?? null,
      c
        ? `${t.processingDelayMs !== null ? `processing delay ${spanText(t.processingDelayMs)} after the trade` : ''}${c.run ? ` · ${c.run.trigger} run started ${fmtExact(c.run.startedAt)}` : ''}${c.stampedWithRunStart ? ' · recorded with the run’s start (before 2026-11-27): the actual read was between that and the run’s end' : ''}`
        : 'not verified yet',
    ],
    [
      'Stored (that run finished)',
      c?.run?.finishedAt ?? null,
      c?.run?.finishedAt ? null : 'run still in progress or unknown',
    ],
    [
      'This dialog loaded',
      new Date(loadedAt).toISOString(),
      c?.run?.finishedAt
        ? `display delay ${spanText(loadedAt - Date.parse(c.run.finishedAt))} after it was stored (the page reloads within 30 s of a new result)`
        : null,
    ],
  ];
  return (
    <>
      <p className="muted small">{`All times in ${tz()}, with milliseconds and the UTC offset.`}</p>
      <ol className="obs-chain">
        {steps.map(([label, at, note]) => (
          <li key={label} className={at ? undefined : 'pending'}>
            <b>{label}</b>
            <span className="mono">{at ? fmtExact(at) : '—'}</span>
            {note ? <span className="muted small">{note}</span> : null}
          </li>
        ))}
      </ol>
      {stages.length ? (
        <p className="muted small">
          {`Pipeline run ${t.pipelineRunId?.slice(0, 8) ?? '—'} stages: ${stages
            .map(
              (s) =>
                `${s.stage} ${spanText(s.durationMs!)}${s.attempts > 1 ? ` (×${s.attempts})` : ''}`,
            )
            .join(' · ')}.`}
          {slowest && slowest.stage === 'daily' && (slowest.durationMs ?? 0) > 60_000
            ? ` The 00:07 UTC run (${fmtClock('2026-01-01T00:07:00Z')} ${tz()}) refreshes every candidate’s newly completed UTC daily row from CoinMarketCap (one request each, rate-limited) before the scan can publish; other hours skip that.`
            : ''}
        </p>
      ) : null}
    </>
  );
}

/** Every request fired at this event's publication, both venues, on one time line. */
function PublicationRequests({ d }: { d: ObservationDetail }) {
  const start = d.window?.start ?? null;
  const rel = (at: string | null) =>
    at && start ? ` (${delayText(Date.parse(at) - Date.parse(start))})` : '';
  const reqs = [
    ...d.publicationRequests.futures.map((x) => ({
      ...x,
      label: `Futures marketData · ${x.trigger.toLowerCase()}${x.attempt > 1 ? ` attempt ${x.attempt}` : ''}`,
    })),
    ...d.publicationRequests.spot.map((x) => ({
      ...x,
      label: `Spot all-pairs price${x.failedAttempts.length ? ` (${x.failedAttempts.length} failed attempt(s) inside)` : ''}`,
    })),
  ].sort(
    (a, b) =>
      Date.parse(a.startedAt ?? a.receivedAt ?? '') - Date.parse(b.startedAt ?? b.receivedAt ?? ''),
  );
  const s = d.spotIndicative;
  const p = d.publicationQuotes;
  return (
    <>
      <p className="muted small">
        Both venues are asked the moment the Review Queue is published: the Futures quote first (it
        is the Futures reference), the Spot price request right behind it. The LBank client spaces
        request starts at least one pacing interval apart, so they are initiated together but never
        sent or answered at the same instant. Times are ours (sent, received, stored); LBank gives
        no trade time for either price.
      </p>
      {reqs.length ? (
        <ul className="small obs-reqs">
          {reqs.map((x) => (
            <li key={`${x.label}${x.requestId}`}>
              <b>{x.label}</b>
              {` queued ${fmtExact(x.queuedAt)} · sent ${fmtExact(x.startedAt)}${rel(x.startedAt)} · received ${fmtExact(x.receivedAt)}${rel(x.receivedAt)} · stored ${fmtExact(x.storedAt)} · ${x.ok ? 'ok' : `failed: ${x.error ?? 'unknown'}`}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">
          No publication request is recorded for this event (events before 2026-11-27 had none; the
          Futures side then came from the minute sampler).
        </p>
      )}
      <Kv
        pairs={[
          s && [
            'Spot price at publication (indicative)',
            `${fmtPrice(s.price)} (${s.pair}) · received ${fmtExact(s.observedAt)} (${delayText(s.delayMs)} after publication) · LBank response time ${fmtExact(s.lbankResponseAt)} (not a trade time)`,
          ],
          s && [
            'What it is',
            'context for a same-moment comparison only: never the Spot reference (the first verified trade), never in a Spot return, highest, lowest, status or coverage',
          ],
          p && [
            'Spot vs Futures request',
            `sent ${diffText(p.sentDifferenceMs)} after the Futures request, answered ${diffText(p.receivedDifferenceMs)} after it${p.queuedTogether ? ' · both queued at the publication' : ''} — not simultaneous`,
          ],
          !s &&
            d.publicationRequests.spot.length > 0 && [
              'Spot price at publication',
              'not recorded: the request failed, the pair was missing from the answer, or the pair mapping was not settled',
            ],
        ]}
      />
    </>
  );
}

function VenueCards({ d }: { d: ObservationDetail }) {
  const f = d.futuresSampled;
  return (
    <div className="obs-venues">
      <section className="obs-venue">
        <header>
          <b>LBank Spot</b>
          <span className="muted small">{`verified trades · ${d.rulesVersion}`}</span>
        </header>
        <p>
          <span className={`obs-final${d.status === 'FINAL' ? ' on' : ''}`}>
            {d.status === 'FINAL' ? 'Final' : 'Provisional'}
          </span>{' '}
          <Lab map={STATUS} k={d.status} />
        </p>
        <Kv
          pairs={[
            [
              'Reference',
              d.reference.price !== null && d.reference.delayMs !== null
                ? `${fmtPrice(d.reference.price)} · trade ${delayText(d.reference.delayMs)} after start${d.reference.delayed ? ' · Delayed' : ''}`
                : humanize(d.reference.status),
            ],
            [
              'Highest',
              d.highest ? `${fmtPct(d.highest.pct)} · ${fmtPrice(d.highest.price)}` : '—',
            ],
            ['Lowest', d.lowest ? `${fmtPct(d.lowest.pct)} · ${fmtPrice(d.lowest.price)}` : '—'],
            [
              'Data through (1-min candles)',
              d.freshness.dataThrough ? fmtExact(d.freshness.dataThrough) : 'not fetched',
            ],
          ]}
        />
        {d.reasons.length ? (
          <p className="muted small">{d.reasons.map(obsReasonText).join(' · ')}</p>
        ) : null}
      </section>
      <section className="obs-venue">
        <header>
          <b>LBank Futures</b>
          <span className="muted small">{`${f?.method === 'LEGACY_TURNOVER_BRACKET' ? 'old method' : 'observed quotes'} · ${f?.rulesVersion ?? '—'}`}</span>
        </header>
        {f ? (
          <>
            <p>
              <Lab map={FUT_STATUS} k={f.status} />{' '}
              <span className="muted small">{f.contract ?? humanize(f.mapping).toLowerCase()}</span>
            </p>
            {f.method === 'OBSERVED_QUOTE' && f.quote ? (
              <Kv
                pairs={[
                  [
                    FUTURES_QUOTE_LABEL,
                    `${fmtPrice(f.quote.price)} · observed ${delayText(f.quote.delayMs)} after signal`,
                  ],
                  ['Observed at', fmtExact(f.quote.observedAt)],
                  [
                    'Highest observed',
                    f.highest ? `${fmtPct(f.highest.pct)} · ${fmtPrice(f.highest.price)}` : '—',
                  ],
                  [
                    'Lowest observed',
                    f.lowest ? `${fmtPct(f.lowest.pct)} · ${fmtPrice(f.lowest.price)}` : '—',
                  ],
                  [
                    'Observed through (our latest response)',
                    f.observedThrough ? fmtExact(f.observedThrough) : '—',
                  ],
                ]}
              />
            ) : f.method === 'LEGACY_TURNOVER_BRACKET' && f.reference ? (
              <Kv
                pairs={[
                  [
                    'Reference (old method)',
                    `${fmtPrice(f.reference.price)} · turnover-rise snapshot pair`,
                  ],
                  [
                    'Highest ≥ (old)',
                    f.highest ? `${fmtPct(f.highest.pct)} · ${fmtPrice(f.highest.price)}` : '—',
                  ],
                  [
                    'Lowest ≤ (old)',
                    f.lowest ? `${fmtPct(f.lowest.pct)} · ${fmtPrice(f.lowest.price)}` : '—',
                  ],
                  f.postFixQuote && [
                    'First price observed after the fix',
                    `${fmtPrice(f.postFixQuote.price)} · ${delayText(f.postFixQuote.delayMs)} after signal (not an entry quote)`,
                  ],
                  [
                    'LBank snapshot time through (old method)',
                    f.lbankSnapshotThrough ? fmtExact(f.lbankSnapshotThrough) : '—',
                  ],
                ]}
              />
            ) : (
              <p className="small">{FUT_STATUS_TEXT[f.status] ?? humanize(f.status)}</p>
            )}
            {FUT_EVIDENCE[f.evidenceClass] ? (
              <p className="small" title={FUT_EVIDENCE[f.evidenceClass]![1]}>
                {`Entry evidence: ${FUT_EVIDENCE[f.evidenceClass]![0]}${f.immediateEntry ? ' (counted as an immediate Futures entry)' : ' (not an immediate Futures entry)'}`}
              </p>
            ) : null}
            {f.reference || f.quote
              ? f.reasons.filter((x) => x !== 'WINDOW_OPEN').length > 0 && (
                  <p className="muted small">
                    {f.reasons
                      .filter((x) => x !== 'WINDOW_OPEN')
                      .map(obsReasonText)
                      .join(' · ')}
                  </p>
                )
              : ['MAPPING_AMBIGUOUS', 'MAPPING_UNKNOWN', 'NO_REFERENCE'].includes(f.status) && (
                  <p className="muted small">{f.reasons.map(obsReasonText).join(' · ')}</p>
                )}
          </>
        ) : (
          <p className="muted small">
            Not created yet (the Futures sampler adds it within a minute).
          </p>
        )}
      </section>
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const [d, setD] = useState<ObservationDetail | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<ObservationDetail>(`observations/${id}`).then(
      (x) => {
        if (!live) return;
        setD(x);
        setLoadedAt(Date.now());
      },
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [id, reloads]);
  // The page behind this dialog checks for new values every 30 s; when Spot or Futures values
  // changed it reloads its rows and this dialog reloads the observation (sections stay as opened).
  useEffect(() => onObservationChange(() => setReloads((n) => n + 1)), []);
  if (error) return <p className="form-error">{error}</p>;
  if (!d) return <p className="muted small">Loading…</p>;
  const ae = obj(d.actionableEvidence);
  const re = obj(d.referenceEvidence);
  const xe = d.extremesEvidence ?? {};
  const fe = obj(d.flagsEvidence);
  const el = obj(d.eligibilityEvidence);
  const futuresBefore = obj(el.cmcFutures);
  const futuresAfter = obj(el.lbankFutures);
  const spotList = obj(el.lbankSpotList);
  const mapping = obj(d.mappingEvidence);
  const snap = obj(fe.mappingSnapshot);
  const sameMs = Array.isArray(re.sameMs) ? (re.sameMs as Json[]) : [];
  const f = d.futuresSampled;
  const fev = d.futuresEvidence;
  const fmap = obj(fev?.mappingEvidence);
  const last = obj(fev?.lastSample);
  const legacy = d.futuresAudit?.legacyReplay ?? null;
  const failed = d.futuresAudit?.failedAttempts ?? [];
  const flags = [...d.flags, ...(f?.flags ?? [])];
  return (
    <div className="fwd-explain obs-detail">
      <p className="obs-ident">
        <Stars n={d.stars} /> <b>{`${d.symbol} · ${d.name}`}</b>
        <span className="muted small">{` CMC id ${d.cmcId} · event UTC date ${d.event.detectedUtcDate} · window ${d.window ? `${fmtTime(d.window.start)} – ${fmtTime(d.window.end)} (${tz()})` : 'start pending'} · exact times below in ${tz()}`}</span>
      </p>
      <VenueCards d={d} />
      <p className="muted small">
        Observed prices, not trades: no order, fill, fee, stop, target, leverage or profit is
        modelled. Each venue is measured only against its own reference.
      </p>

      <Section
        title="Timing: from the CMC crawl to this page"
        hint="market, processing and display delays"
        open={d.reference.status === 'PENDING'}
      >
        <TimingChain d={d} loadedAt={loadedAt} />
        <Kv
          pairs={[
            d.window && [
              'Start proven by',
              `${TIMING_TEXT[d.window.source] ?? d.window.source}${d.window.uncertain ? ' (later than the earliest usable moment)' : ''}`,
            ],
            !!str(ae.lowerBound) && [
              'Usable between',
              `${fmtExact(str(ae.lowerBound))} and ${d.window ? fmtExact(d.window.start) : '—'}`,
            ],
            [
              'Window end (exclusive)',
              d.window ? `${fmtExact(d.window.end)} = start + 168 h` : '—',
            ],
            ['CMC quote time', fmtExact(d.cmcQuoteAt)],
            ['Retries until', fmtExact(d.freshness.retryUntil)],
          ]}
        />
      </Section>

      <Section
        title="At publication: both venues’ requests"
        hint={
          d.publicationQuotes
            ? `Spot answered ${diffText(d.publicationQuotes.receivedDifferenceMs)} after Futures`
            : d.spotIndicative
              ? 'Spot quote recorded'
              : 'no Spot quote'
        }
      >
        <PublicationRequests d={d} />
      </Section>

      <Section
        title="Spot reference trade"
        hint={
          d.reference.tradeId
            ? `id ${d.reference.tradeId.slice(0, 13)}…`
            : humanize(d.reference.status)
        }
      >
        <Kv
          pairs={[
            ['Status', humanize(d.reference.status)],
            d.reference.price !== null && ['Price', fmtPrice(d.reference.price)],
            d.reference.at !== null && ['Trade time', fmtExact(d.reference.at)],
            d.reference.tradeId !== null && [
              'Trade id',
              <code key="t">{d.reference.tradeId}</code>,
            ],
            d.reference.qty !== null && ['Quantity', d.reference.qty],
            d.reference.delayMs !== null && [
              'Start → trade (market delay)',
              `${delayText(d.reference.delayMs)}${d.reference.delayed ? ' · Delayed: a whole minute without trades first' : ''}`,
            ],
            sameMs.length > 0 && [
              'Same millisecond',
              sameMs.map((t) => `${String(t.price)} (${String(t.id)})`).join(', '),
            ],
          ]}
        />
        <p className="muted small">
          The first verified LBank Spot trade at or after the window start; an observed trade, not a
          claim that an order could have filled at that price or size.
        </p>
      </Section>

      <Section
        title="Spot highest and lowest (verified trades in [start, end))"
        hint={d.extremesProven ? 'proven for the whole window' : 'provisional'}
      >
        <Extreme label="Highest" ev={xe.highest ?? null} pct={d.highest?.pct ?? null} />
        <Extreme label="Lowest" ev={xe.lowest ?? null} pct={d.lowest?.pct ?? null} />
        <Kv
          pairs={[
            d.lowBeforeHighest && [
              'Lowest up to the highest',
              `${fmtPrice(d.lowBeforeHighest.price)} at ${fmtExact(d.lowBeforeHighest.at)}`,
            ],
            ['Order', d.order ? (ORDER[d.order] ?? d.order) : '—'],
          ]}
        />
      </Section>

      <Section
        title="Futures"
        hint={f ? `${FUT_STATUS[f.status]?.[1] ?? f.status} · ${f.rulesVersion}` : 'not created'}
      >
        {f?.method === 'LEGACY_TURNOVER_BRACKET' ? (
          <p className="small">
            Old method ({f.rulesVersion}), kept as recorded: the reference is the later of two
            minute snapshots between which LBank’s 24 h turnover rose. That rule could miss trades
            (rolling 24 h turnover can fall while trades happen) and is not the first price observed
            after the signal. Events detected after 2026-11-27 use observed quotes instead.
          </p>
        ) : (
          <p className="small">
            {FUTURES_QUOTE_LABEL}: our request is sent the moment the Review Queue is published; the
            first valid LBank Futures <code>lastPrice</code> returned by a request sent at or after
            that moment is the reference, timed by when its response arrived. LBank’s response has
            no trade time, so that price may come from a trade before the signal. It is an observed
            API quote — not the first Futures trade after the signal and not an order’s execution
            price. Highest and lowest are the extreme prices our requests observed in the window
            (not verified trades). Spot data never fills a Futures gap.
          </p>
        )}
        {f ? (
          <Kv
            pairs={[
              ['Contract', f.contract ?? '—'],
              [
                'Mapping',
                `${humanize(f.mapping)}${f.reasons.length ? ` · ${f.reasons.map(obsReasonText).join(' · ')}` : ''}`,
              ],
              [
                'CMC contracts for this CMC id',
                Array.isArray(fmap.cmcContracts)
                  ? (fmap.cmcContracts as string[]).join(', ') || 'none'
                  : '—',
              ],
              f.quote && ['Observed price', fmtPrice(f.quote.price)],
              f.quote && ['Request queued', fmtExact(f.quote.requestQueuedAt)],
              f.quote && [
                'Request sent',
                `${fmtExact(f.quote.requestStartedAt)} · ${delayText(f.quote.publicationToRequestMs)} after publication`,
              ],
              f.quote && [
                'Response received',
                `${fmtExact(f.quote.observedAt)} · ${spanText(f.quote.requestToResponseMs)} after sending · ${delayText(f.quote.delayMs)} after publication (the displayed delay)`,
              ],
              f.quote && ['Stored', fmtExact(f.quote.storedAt)],
              f.quote && [
                'Sent by',
                `${QUOTE_SOURCE_TEXT[f.quote.source] ?? f.quote.source}${f.quote.failedAttemptsBefore ? ` · ${f.quote.failedAttemptsBefore} failed attempt(s) before` : ''}`,
              ],
              f.quote && [
                'LBank snapshot time',
                `${fmtExact(f.quote.lbankSnapshotAt)} (refresh time of LBank’s snapshot, not a trade time)`,
              ],
              f.quote && ['Endpoint · request id', `${f.quote.endpoint} · ${f.quote.pollId}`],
              f.method === 'OBSERVED_QUOTE' &&
                f.highest && [
                  'Highest observed',
                  `${fmtPrice(f.highest.price)} (${fmtPct(f.highest.pct)}) at ${fmtExact(f.highest.observedAt)}`,
                ],
              f.method === 'OBSERVED_QUOTE' &&
                f.lowest && [
                  'Lowest observed',
                  `${fmtPrice(f.lowest.price)} (${fmtPct(f.lowest.pct)}) at ${fmtExact(f.lowest.observedAt)}`,
                ],
              f.method === 'LEGACY_TURNOVER_BRACKET' &&
                f.reference && [
                  'Old-method reference',
                  `${fmtPrice(f.reference.price)} (snapshot pair ${fmtExact(f.reference.after)} – ${fmtExact(f.reference.before)})`,
                ],
              f.method === 'LEGACY_TURNOVER_BRACKET' &&
                f.highest && [
                  'Old-method highest (≥)',
                  `${fmtPrice(f.highest.price)} (${fmtPct(f.highest.pct)})`,
                ],
              f.method === 'LEGACY_TURNOVER_BRACKET' &&
                f.lowest && [
                  'Old-method lowest (≤)',
                  `${fmtPrice(f.lowest.price)} (${fmtPct(f.lowest.pct)})`,
                ],
              f.postFixQuote && [
                'First price observed after the fix',
                `${fmtPrice(f.postFixQuote.price)} at ${fmtExact(f.postFixQuote.observedAt)} · ${delayText(f.postFixQuote.delayMs)} after the signal — shown apart, not an entry quote`,
              ],
              !!legacy && [
                'Replay of retained records',
                legacy.correctedReferenceEstablished
                  ? `first price observed after the signal: ${fmtPrice(legacy.retainedPrice)} at ${fmtExact(legacy.firstEligibleResponseAt)} (${legacy.reconstructedDelayMs !== null ? delayText(legacy.reconstructedDelayMs) : '—'} after the signal; minute tick sent at or after ${fmtExact(legacy.firstEligibleRequestSentNotBefore)})`
                  : `not establishable — the first response after the signal (${fmtExact(legacy.firstEligibleResponseAt)}) was not retained for this contract`,
              ],
              !!legacy && ['Replay note', legacy.note],
              failed.length > 0 && [
                'Failed attempts before the first price',
                failed
                  .map(
                    (x) =>
                      `${x.trigger} #${x.attempt} sent ${fmtExact(x.requestStartedAt)} failed ${fmtExact(x.failedAt)}: ${x.error ?? ''}`,
                  )
                  .join(' · '),
              ],
              f.book && [
                'Order book (context only)',
                f.book.ok
                  ? `bid ${f.book.bestBid ?? '—'} / ask ${f.book.bestAsk ?? '—'} · sent ${fmtExact(f.book.requestStartedAt)} · received ${fmtExact(f.book.responseReceivedAt)}${f.book.afterQuoteMs !== null ? ` (${diffText(f.book.afterQuoteMs)} after the quote’s response)` : ''} — a later book than the quote’s moment, not the book the quote met; indicative, never the reference or a fill`
                  : `failed: ${f.book.error ?? 'unknown'} (received ${fmtExact(f.book.responseReceivedAt)})`,
              ],
              [
                'Observations in window',
                `${f.samplesInWindow} · longest gap ${spanText(f.maxGapMs)} (${TIME_BASIS[f.throughBasis]?.[0] ?? f.throughBasis} time base)`,
              ],
              [
                f.throughBasis === 'OUR_RESPONSE_RECEIVED'
                  ? 'Observed through'
                  : 'LBank snapshot time through (old method)',
                `${fmtExact(f.observedThrough ?? f.lbankSnapshotThrough)} — ${TIME_BASIS[f.throughBasis]?.[1] ?? ''}`,
              ],
              [
                'Sampling limit',
                'about one observation a minute: a move between two observations can be missed, so the observed highest and lowest are not proof of the exact high or low',
              ],
              FUT_EVIDENCE[f.evidenceClass] && [
                'Entry evidence',
                `${FUT_EVIDENCE[f.evidenceClass]![0]}: ${FUT_EVIDENCE[f.evidenceClass]![1]}`,
              ],
              !!str(last.server_at) && [
                'LBank 24 h high / low at the last snapshot (context only)',
                `${String(last.high_24h ?? '—')} / ${String(last.low_24h ?? '—')} (${fmtExact(str(last.server_at))}; not the window's extremes)`,
              ],
              ['Rules', f.rulesVersion],
            ]}
          />
        ) : null}
      </Section>

      <Section
        title="Coverage and gaps"
        hint={
          d.coverageTimes.differs
            ? `venues ${diffText(d.coverageTimes.differenceMs ?? 0)} apart`
            : d.coverage.gaps.length
              ? `${d.coverage.gaps.length} gap(s)`
              : 'no gap so far'
        }
      >
        <Kv
          pairs={[
            [
              'Spot data through (1-min candles, exclusive)',
              fmtExact(d.coverageTimes.spotDataThrough),
            ],
            [
              `Futures ${TIME_BASIS[d.coverageTimes.futuresBasis ?? '']?.[0] ?? 'through'}`,
              `${fmtExact(d.coverageTimes.futuresThrough)}${d.coverageTimes.futuresBasis ? ` — ${TIME_BASIS[d.coverageTimes.futuresBasis]?.[1] ?? ''}` : ''}`,
            ],
            d.coverageTimes.differenceMs !== null && [
              'Futures − Spot',
              `${diffText(d.coverageTimes.differenceMs)}: ${d.coverageTimes.differs ? 'the venues’ values cover visibly different spans (more than a minute apart); Spot highest / lowest are verified trades up to its time, Futures values are observed quotes up to its own' : 'within a minute of each other (still not the same instants)'}`,
            ],
            [
              'Minutes',
              `${d.coverage.minutesPresent} of ${d.coverage.minutesExpected ?? '—'} with a candle · ${d.coverage.minutesTraded} traded · ${d.coverage.minutesMissing} answered without one`,
            ],
            ['Data through', fmtExact(d.freshness.dataThrough)],
            ['Last successful LBank fetch', fmtExact(d.freshness.lastSourceFetchAt)],
            ['Last attempt', fmtExact(d.freshness.lastFetchAttemptAt)],
            d.freshness.lastFetchError !== null && ['Last error', d.freshness.lastFetchError],
            ['Last recomputed (not fresh data)', fmtExact(d.freshness.lastRecomputedAt)],
          ]}
        />
        {d.coverage.gaps.length ? (
          <ul className="small">
            {d.coverage.gaps.map((g) => (
              <li key={`${g.from}${g.state}${g.detail ?? ''}`}>
                {`${fmtExact(g.from)} – ${fmtExact(g.to)}: ${GAP_TEXT[g.state] ?? humanize(g.state)}${g.detail ? ` (${humanize(g.detail).toLowerCase()})` : ''}`}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Pair, contract and listing evidence" hint={d.pair.symbol ?? 'no pair'}>
        <Kv
          pairs={[
            [
              'LBank Spot pair',
              `${d.pair.symbol ?? '—'} (${MAPPING_TEXT[d.pair.mapping] ?? humanize(d.pair.mapping)})`,
            ],
            ['Mapping rule', str(mapping.rule) ?? '—'],
            !!str(snap.cmcLbankSpotListFetchedAt) && [
              'CMC LBank list used',
              `${fmtExact(str(snap.cmcLbankSpotListFetchedAt))} (${String(snap.ageAtSignalHours)} h before the signal)`,
            ],
            [
              'Spot at the signal',
              `${LISTING_TEXT[d.spot] ?? d.spot}${d.spotTrading ? ` · ${TRADING_TEXT[d.spotTrading] ?? d.spotTrading}` : ''}${spotList.fetchedAt ? ` · LBank list read ${fmtExact(str(spotList.fetchedAt))}` : ''}`,
            ],
            ['Listing class', <Lab key="e" map={ELIGIBILITY} k={d.eligibility} />],
            ['Futures listing (snapshots)', FUTURES_TEXT[d.futures] ?? d.futures],
            [
              'Snapshot before',
              futuresBefore.fetchedAt
                ? `CMC LBank Futures list ${fmtExact(str(futuresBefore.fetchedAt))}`
                : 'none',
            ],
            [
              'Snapshot after',
              futuresAfter.fetchedAt
                ? `LBank contract list ${fmtExact(str(futuresAfter.fetchedAt))}`
                : 'none',
            ],
          ]}
        />
      </Section>

      <Section
        title="Review flags"
        hint={flags.length ? flags.map((x) => FLAG[x]?.[0] ?? humanize(x)).join(', ') : 'none'}
      >
        {flags.length ? (
          <ul className="small">
            {flags.map((x) => {
              const ev = obj(
                fe[
                  x === 'SINGLE_TRADE_HIGH'
                    ? 'singleTradeHigh'
                    : x === 'SINGLE_TRADE_LOW'
                      ? 'singleTradeLow'
                      : ''
                ],
              );
              const prev = obj(ev.previousTrade);
              const next = obj(ev.nextTrade);
              return (
                <li key={x}>
                  {`${FLAG[x]?.[0] ?? humanize(x)}: ${FLAG[x]?.[1] ?? ''}`}
                  {ev.tradeId
                    ? ` Trade ${String(ev.price)} × ${String(ev.qty)} (${String(ev.quoteValueUsdt)} USDT) at ${fmtExact(str(ev.time))}, minute volume ${String(ev.minuteVolume)}; previous trade ${prev.price ? `${String(prev.price)} at ${fmtExact(str(prev.time))}` : 'unknown'}; next ${next.price ? `${String(next.price)} at ${fmtExact(str(next.time))}` : 'unknown'}.`
                    : ''}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted small">No review flag.</p>
        )}
        <p className="muted small">
          Flags help interpretation; they are not proof of an error and exclude nothing.
        </p>
      </Section>

      <Section
        title="Rules versions, results and audit"
        hint={`Spot ${d.displayedRulesVersion} · Futures ${f?.rulesVersion ?? '—'}`}
      >
        {d.results.length ? (
          <ul className="small">
            {d.results.map((r) => (
              <li key={r.version}>
                {`Spot result v${r.version} (${r.rulesVersion}): ${r.status}${r.highestReturnPct !== null ? `, highest ${fmtPct(r.highestReturnPct)}, lowest ${fmtPct(r.lowestReturnPct)}` : ''}${r.v1MaxRisePct !== null ? `, v1 max rise ${fmtPct(r.v1MaxRisePct)}, max drop ${fmtPct(r.v1MaxDropPct)}` : ''} · ${fmtExact(r.computedAt)}`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No frozen Spot result yet.</p>
        )}
        {d.rulesChanges.map((c) => (
          <p key={c.changedAt} className="muted small">
            {`Recalculated under ${c.to} on ${fmtExact(c.changedAt)} (was ${c.from}, ${c.fromStatus}${c.fromResultVersion ? `, result v${c.fromResultVersion}` : ''}). ${c.reason}`}
          </p>
        ))}
        {d.legacyV1 ? (
          <p className="muted small">
            {`Rules v1 audit (candle OPEN from the crawl time; not used): entry ${String(d.legacyV1.entryPrice ?? '—')}, max rise ${d.legacyV1.maxRisePct ? fmtPct(String(d.legacyV1.maxRisePct)) : '—'}, max drop ${d.legacyV1.maxDropPct ? fmtPct(String(d.legacyV1.maxDropPct)) : '—'}.`}
          </p>
        ) : null}
      </Section>

      <Section title="Identifiers and provenance">
        <Kv
          pairs={[
            ['Observation id', <code key="o">{d.id}</code>],
            ['Event id', <code key="e">{d.eventId}</code>],
            ['CMC batch id', <code key="b">{d.event.sourceBatchId}</code>],
            ['Pipeline run id', <code key="p">{d.timeline.pipelineRunId ?? '—'}</code>],
            ['Spot evidence hash', d.evidenceSha256 ?? 'set when final'],
            [
              'Spot price source',
              'LBank Spot trades (REST /v2/supplement/trades.do), located with 1-minute candles',
            ],
            ['Futures price source', fev?.priceSource ?? '—'],
          ]}
        />
      </Section>
    </div>
  );
}

export const openObservationDetail = (r: ObservationRow) =>
  void infoDialog(`${r.symbol} ${r.stars}★ · LBank observation`, <Detail id={r.id} />, {
    wide: true,
  });

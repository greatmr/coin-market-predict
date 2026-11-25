// Everything behind one LBank Spot observation (GET /api/observations/:id): the CMC signal and its
// crawl / quote times, the proven window start and its evidence, the reference trade, the verified
// extremes with the candidate minutes that were checked, coverage, gaps and data freshness, the pair
// mapping, Spot and Futures evidence, review flags, and the result and rules history (rules v1
// values as audit only). Loaded when the dialog opens.
import { useEffect, useState } from 'react';

import { Kv, Lab, Stars } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { humanize } from '../../lib/constants';
import { infoDialog } from '../../lib/feedback';
import { fmtPct, fmtPrice, utc } from '../../lib/format';

import {
  ELIGIBILITY,
  FLAG,
  FUTURES_TEXT,
  GAP_TEXT,
  LISTING_TEXT,
  MAPPING_TEXT,
  ORDER,
  STATUS,
  TIMING_TEXT,
  TRADING_TEXT,
  delayText,
  obsReasonText,
} from './labels';
import type { ExtremeEvidence, ObservationDetail, ObservationRow } from './types';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

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
          ['Trade', `${utc(ev.best.time)} · id ${ev.best.id} · qty ${ev.best.qty}`],
          [
            'Proven',
            ev.proven ? 'yes: no other minute could hold a more extreme price' : 'not yet',
          ],
        ]}
      />
      {ev.checked.length ? (
        <p className="muted small">
          {`Candidate minutes checked trade by trade (candle bound → highest/lowest real trade): ${ev.checked
            .map(
              (c) =>
                `${utc(c.minute).slice(11, 16)} ${c.candle}→${c.traded ?? c.check.toLowerCase()}`,
            )
            .join(', ')}`}
        </p>
      ) : null}
      {ev.blocking.length ? (
        <p className="muted small">
          {`Still open: ${ev.blocking
            .slice(0, 6)
            .map((b) => `${utc(b.from)}–${utc(b.to)} ${humanize(b.state).toLowerCase()}`)
            .join('; ')}`}
        </p>
      ) : null}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const [d, setD] = useState<ObservationDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<ObservationDetail>(`observations/${id}`).then(setD, (e: unknown) =>
      setError(errorMessage(e)),
    );
  }, [id]);
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
  return (
    <div className="fwd-explain">
      <p className="muted small">
        {`LBank Spot price observation · rules ${d.displayedRulesVersion} (the values shown and exported) · every price is an LBank Spot trade; the CMC price is context only. Not a trade, not profit, no stop, target, fee or leverage.`}
      </p>
      <h3>Signal</h3>
      <Kv
        pairs={[
          ['Coin', `${d.symbol} · ${d.name} · CMC id ${d.cmcId}`],
          ['Stars', <Stars key="s" n={d.stars} />],
          [
            'Event (CMC id, UTC date, stars)',
            `${d.cmcId} · ${d.event.detectedUtcDate} · ${d.stars}★`,
          ],
          ['CMC crawl (t0)', utc(d.crawlAt)],
          ['CMC quote time', utc(d.cmcQuoteAt)],
          ['CMC price (context)', `${d.cmcPriceUsd} USD`],
        ]}
      />
      <h3>Window</h3>
      <Kv
        pairs={[
          ['Start (signal usable)', d.window ? utc(d.window.start) : 'not established yet'],
          d.window && [
            'Proven by',
            `${TIMING_TEXT[d.window.source] ?? d.window.source}${d.window.uncertain ? ' (later than the earliest usable moment)' : ''}`,
          ],
          d.window && ['After the crawl', delayText(d.window.afterCrawlMs).slice(1)],
          !!str(ae.lowerBound) && [
            'Usable between',
            `${utc(str(ae.lowerBound))} and ${d.window ? utc(d.window.start) : '—'}`,
          ],
          ['End (exclusive)', d.window ? `${utc(d.window.end)} = start + 168 h` : '—'],
          ['Retries until', utc(d.freshness.retryUntil)],
        ]}
      />
      <h3>Reference (first verified LBank Spot trade at or after the start)</h3>
      <Kv
        pairs={[
          ['Status', humanize(d.reference.status)],
          d.reference.price !== null && ['Reference price', fmtPrice(d.reference.price)],
          d.reference.at !== null && ['Trade time', utc(d.reference.at)],
          d.reference.tradeId !== null && ['Trade id', d.reference.tradeId],
          d.reference.qty !== null && ['Quantity', d.reference.qty],
          d.reference.delayMs !== null && [
            'Delay after the start',
            `${delayText(d.reference.delayMs)}${d.reference.delayed ? ' · delayed (a whole minute without trades)' : ''}`,
          ],
          sameMs.length > 0 && [
            'Same millisecond',
            sameMs.map((t) => `${String(t.price)} (${String(t.id)})`).join(', '),
          ],
        ]}
      />
      <p className="muted small">
        An observed trade price, not a claim that an order could have been filled at that price or
        size.
      </p>
      <h3>Extremes (verified trades in [start, end))</h3>
      <Extreme label="Highest" ev={xe.highest ?? null} pct={d.highest?.pct ?? null} />
      <Extreme label="Lowest" ev={xe.lowest ?? null} pct={d.lowest?.pct ?? null} />
      <Kv
        pairs={[
          d.lowBeforeHighest && [
            'Lowest up to the highest',
            `${fmtPrice(d.lowBeforeHighest.price)} at ${utc(d.lowBeforeHighest.at)}`,
          ],
          ['Order', d.order ? (ORDER[d.order] ?? d.order) : '—'],
          ['Evidence hash', d.evidenceSha256 ?? 'set when final'],
        ]}
      />
      <h3>Coverage and data freshness</h3>
      <Kv
        pairs={[
          [
            'Minutes',
            `${d.coverage.minutesPresent} of ${d.coverage.minutesExpected ?? '—'} with a candle · ${d.coverage.minutesTraded} traded · ${d.coverage.minutesMissing} answered without one`,
          ],
          ['Data through', utc(d.freshness.dataThrough)],
          ['Last successful LBank fetch', utc(d.freshness.lastSourceFetchAt)],
          ['Last attempt', utc(d.freshness.lastFetchAttemptAt)],
          d.freshness.lastFetchError !== null && ['Last error', d.freshness.lastFetchError],
          ['Last recomputed', utc(d.freshness.lastRecomputedAt)],
        ]}
      />
      {d.coverage.gaps.length ? (
        <ul className="small">
          {d.coverage.gaps.slice(0, 12).map((g) => (
            <li key={`${g.from}${g.state}${g.detail ?? ''}`}>
              {`${utc(g.from)} – ${utc(g.to)}: ${GAP_TEXT[g.state] ?? humanize(g.state)}${g.detail ? ` (${humanize(g.detail).toLowerCase()})` : ''}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No gap so far.</p>
      )}
      <h3>Status</h3>
      <p>
        <Lab map={STATUS} k={d.status} />{' '}
        <span className="muted small">{d.reasons.map(obsReasonText).join(' · ')}</span>
      </p>
      <h3>Pair, Spot and Futures evidence</h3>
      <Kv
        pairs={[
          [
            'LBank Spot pair',
            `${d.pair.symbol ?? '—'} (${MAPPING_TEXT[d.pair.mapping] ?? humanize(d.pair.mapping)})`,
          ],
          ['Mapping rule', str(mapping.rule) ?? '—'],
          !!str(snap.cmcLbankSpotListFetchedAt) && [
            'CMC LBank list used',
            `${utc(str(snap.cmcLbankSpotListFetchedAt))} (${String(snap.ageAtSignalHours)} h before the signal)`,
          ],
          [
            'Spot at the signal',
            `${LISTING_TEXT[d.spot] ?? d.spot}${d.spotTrading ? ` · ${TRADING_TEXT[d.spotTrading] ?? d.spotTrading}` : ''}${spotList.fetchedAt ? ` · LBank list read ${utc(str(spotList.fetchedAt))}` : ''}`,
          ],
          ['Spot / Futures class', <Lab key="e" map={ELIGIBILITY} k={d.eligibility} />],
          ['Futures (evidence)', FUTURES_TEXT[d.futures] ?? d.futures],
          [
            'Snapshot before',
            futuresBefore.fetchedAt
              ? `CMC LBank Futures list ${utc(str(futuresBefore.fetchedAt))}`
              : 'none',
          ],
          [
            'Snapshot after',
            futuresAfter.fetchedAt
              ? `LBank contract list ${utc(str(futuresAfter.fetchedAt))}`
              : 'none',
          ],
        ]}
      />
      <p className="muted small">
        Futures is listing evidence only: snapshots before and after the signal do not prove a
        contract was tradable at that instant, and no number here is a Futures price, fill or
        leveraged return.
      </p>
      {d.flags.length ? (
        <>
          <h3>Review flags (kept, never excluded)</h3>
          <ul className="small">
            {d.flags.map((f) => {
              const ev = obj(
                fe[
                  f === 'SINGLE_TRADE_HIGH'
                    ? 'singleTradeHigh'
                    : f === 'SINGLE_TRADE_LOW'
                      ? 'singleTradeLow'
                      : ''
                ],
              );
              const prev = obj(ev.previousTrade);
              const next = obj(ev.nextTrade);
              return (
                <li key={f}>
                  {`${FLAG[f]?.[0] ?? humanize(f)}: ${FLAG[f]?.[1] ?? ''}`}
                  {ev.tradeId
                    ? ` — trade ${String(ev.price)} × ${String(ev.qty)} (${String(ev.quoteValueUsdt)} USDT) at ${utc(str(ev.time))}, minute volume ${String(ev.minuteVolume)}; previous trade ${prev.price ? `${String(prev.price)} at ${utc(str(prev.time))}` : 'unknown'}; next ${next.price ? `${String(next.price)} at ${utc(str(next.time))}` : 'unknown'}`
                    : ''}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <h3>History</h3>
      {d.results.length ? (
        <ul className="small">
          {d.results.map((r) => (
            <li key={r.version}>
              {`Result v${r.version} (${r.rulesVersion}): ${r.status}${r.highestReturnPct !== null ? `, highest ${fmtPct(r.highestReturnPct)}, lowest ${fmtPct(r.lowestReturnPct)}` : ''}${r.v1MaxRisePct !== null ? `, v1 max rise ${fmtPct(r.v1MaxRisePct)}, max drop ${fmtPct(r.v1MaxDropPct)}` : ''} · ${utc(r.computedAt)}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No frozen result yet.</p>
      )}
      {d.rulesChanges.map((c) => (
        <p key={c.changedAt} className="muted small">
          {`Recalculated under ${c.to} on ${utc(c.changedAt)} (was ${c.from}, ${c.fromStatus}${c.fromResultVersion ? `, result v${c.fromResultVersion}` : ''}). ${c.reason}`}
        </p>
      ))}
      {d.legacyV1 ? (
        <p className="muted small">
          {`Rules v1 audit (candle OPEN from the crawl time; not used): entry ${String(d.legacyV1.entryPrice ?? '—')}, max rise ${d.legacyV1.maxRisePct ? fmtPct(String(d.legacyV1.maxRisePct)) : '—'}, max drop ${d.legacyV1.maxDropPct ? fmtPct(String(d.legacyV1.maxDropPct)) : '—'}.`}
        </p>
      ) : null}
    </div>
  );
}

export const openObservationDetail = (r: ObservationRow) =>
  void infoDialog(`${r.symbol} ${r.stars}★ · LBank Spot price observation`, <Detail id={r.id} />, {
    wide: true,
  });

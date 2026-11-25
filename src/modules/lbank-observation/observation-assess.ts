import { type DValue, sha256 } from '../../common/utils/decimal.js';

import {
  type Bar,
  type Coverage,
  type ExtremeEval,
  type ListingDecision,
  type MinuteCheck,
  type ObsWindow,
  type PairSync,
  type ReferenceEval,
  type StatusDecision,
  barBeforeSignal,
  classifyEligibility,
  coverage,
  extremesOrder,
  findReference,
  observationStatus,
  observationWindow,
  pctChange,
  rangeExtreme,
  reviewFlags,
  spotAtSignal,
  tradeNearSignal,
} from './observation-rules.js';
import {
  EVIDENCE_MAX_LAG_MS,
  type EligibilityClass,
  type ExtremesOrder,
  MINUTE_MS,
  type MappingStatus,
} from './observation.constants.js';

export interface AssessInput {
  now: Date;
  /** t0: the crawl time (Spot list evidence is judged against it, as fetched by the job). */
  t0: Date;
  /** observation_start, once proven (null: the start is not established yet). */
  start: Date | null;
  /** CMC price at detection: identity review flag only, never a price input. */
  cmcPrice: DValue;
  mapping: MappingStatus;
  mappingReasons: readonly string[];
  /** The pair's stored bars, ascending, covering at least [start − 1 h, min(window end, synced)). */
  bars: readonly Bar[];
  barsByMinute: ReadonlyMap<number, Bar>;
  /** Checked minutes of the pair (trades of the verified ones). */
  checks: ReadonlyMap<number, MinuteCheck>;
  sync: PairSync;
  /** First time LBank answered "currency pair nonsupport" for the pair (null = never / not since). */
  unsupportedSince: Date | null;
  /** LBank's Spot pairs list near the signal: listed, not listed, or no list (null). */
  spotListed: boolean | null;
  futures: ListingDecision;
  fetchError: string | null;
  /** CMC's LBank Spot list behind the mapping was older than the refresh period at the signal. */
  mappingSnapshotOld: boolean;
}

export interface Assessment {
  w: ObsWindow | null;
  reference: ReferenceEval | null;
  highest: ExtremeEval | null;
  lowest: ExtremeEval | null;
  lowBeforeHigh: ExtremeEval | null;
  order: ExtremesOrder | null;
  cov: Coverage | null;
  spot: ReturnType<typeof spotAtSignal>;
  futures: ListingDecision;
  eligibility: EligibilityClass;
  status: StatusDecision;
  highestPct: DValue | null;
  lowestPct: DValue | null;
  flags: string[];
  flagsEvidence: Record<string, unknown>;
  /** Minutes whose complete trades are needed next (reference first), deduplicated. */
  needs: number[];
  /** SHA-256 of the candles and verified trades of the window; set when terminal. */
  evidenceSha256: string | null;
}

/**
 * Everything one observation shows, recomputed from the stored candles and checked trade lists
 * (docs § 4–6). Pure: what is missing is listed in `needs` / gaps for the job to fetch.
 */
export function assess(i: AssessInput): Assessment {
  const w = i.start ? observationWindow(i.start) : null;
  const ok = i.mapping === 'OK' && !!w;
  const reference = ok ? findReference(w, i.barsByMinute, i.checks, i.sync) : null;
  const ref = reference?.status === 'VERIFIED' ? reference : null;
  const highest = ref
    ? rangeExtreme(
        'high',
        { from: ref.trade, to: { beforeMs: w!.endMs } },
        i.barsByMinute,
        i.checks,
        i.sync,
      )
    : null;
  const lowest = ref
    ? rangeExtreme(
        'low',
        { from: ref.trade, to: { beforeMs: w!.endMs } },
        i.barsByMinute,
        i.checks,
        i.sync,
      )
    : null;
  const lowBeforeHigh =
    ref && highest?.best
      ? rangeExtreme(
          'low',
          { from: ref.trade, to: { through: highest.best } },
          i.barsByMinute,
          i.checks,
          i.sync,
        )
      : null;
  const cov = ok ? coverage(w, i.barsByMinute, i.sync) : null;
  const unsupportedNearSignal =
    !!i.unsupportedSince && i.unsupportedSince.getTime() <= i.t0.getTime() + EVIDENCE_MAX_LAG_MS;
  const spot = spotAtSignal({
    listed: i.spotListed,
    unsupportedNearSignal,
    barBeforeT0: ok ? barBeforeSignal(i.bars, w) : false,
    entryBar: ok ? i.barsByMinute.has(w.startMinuteMs) : false,
    tradeNearSignal: ok ? tradeNearSignal(i.bars, w) : false,
  });
  const eligibility = classifyEligibility(i.mapping, spot.status, i.futures.status);
  const status = observationStatus({
    nowMs: i.now.getTime(),
    w,
    mapping: i.mapping,
    mappingReasons: i.mappingReasons,
    spot,
    reference,
    highest,
    lowest,
    lowBeforeHigh,
    cov,
    pairUnsupported: !!i.unsupportedSince,
    fetchError: i.fetchError,
  });
  const highestPct = ref && highest?.best ? pctChange(highest.best.price, ref.trade.price) : null;
  const lowestPct = ref && lowest?.best ? pctChange(lowest.best.price, ref.trade.price) : null;
  // The reference trade is on the observed path: anything else is a defect, never a value.
  if (highestPct?.lt(0) || lowestPct?.gt(0))
    throw new Error('highest return < 0 or lowest return > 0: the reference is not on the path');
  const { flags, evidence } = reviewFlags({
    reference,
    highest,
    lowest,
    checks: i.checks,
    bars: i.barsByMinute,
    cmcPrice: i.cmcPrice,
    mappingSnapshotOld: i.mappingSnapshotOld,
  });
  const needs = [
    ...new Set([
      ...(reference?.status === 'PENDING' ? reference.needs : []),
      ...(highest?.needs ?? []),
      ...(lowest?.needs ?? []),
      ...(lowBeforeHigh?.needs ?? []),
    ]),
  ];
  return {
    w,
    reference,
    highest,
    lowest,
    lowBeforeHigh,
    order: extremesOrder(highest?.best ?? null, lowest?.best ?? null),
    cov,
    spot,
    futures: i.futures,
    eligibility,
    status,
    highestPct,
    lowestPct,
    flags,
    flagsEvidence: evidence,
    needs,
    evidenceSha256: status.terminal && w ? evidenceHash(w, i.bars, i.checks) : null,
  };
}

/** SHA-256 of the window's candles and the verified trades inside it (canonical lines). */
export function evidenceHash(
  w: ObsWindow,
  bars: readonly Bar[],
  checks: ReadonlyMap<number, MinuteCheck>,
): string {
  const lines: string[] = [];
  for (const b of bars)
    if (b.openMs >= w.startMinuteMs && b.openMs < w.endMinuteExclusiveMs)
      lines.push(
        `C,${b.openMs},${b.open.toFixed()},${b.high.toFixed()},${b.low.toFixed()},${b.close.toFixed()},${b.volume.toFixed()}`,
      );
  const minutes = [...checks.keys()]
    .filter((m) => m >= w.startMinuteMs && m < w.endMinuteExclusiveMs)
    .sort((a, b) => a - b);
  for (const m of minutes) {
    const c = checks.get(m)!;
    if (c.status !== 'VERIFIED') continue;
    for (const t of c.trades)
      lines.push(`T,${t.id},${t.timeMs},${t.ord},${t.price.toFixed()},${t.qty.toFixed()}`);
  }
  return sha256(lines.join('\n'));
}

/** Minutes of a window, for loaders: [start − 1 h look-back, window end). */
export const windowSpan = (w: ObsWindow, lookbackMs: number) => ({
  fromMs: w.startMinuteMs - lookbackMs,
  toMs: w.endMinuteExclusiveMs + MINUTE_MS,
});

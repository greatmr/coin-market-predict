import { type DValue, sha256 } from '../../common/utils/decimal.js';

import {
  type Bar,
  type Coverage,
  type EntryResult,
  type Extremes,
  type ListingDecision,
  type ObsWindow,
  type StatusDecision,
  barBeforeSignal,
  classifyEligibility,
  computeExtremes,
  coverage,
  entryDeviatesFromCmc,
  observationStatus,
  observationWindow,
  pctChange,
  selectEntry,
  spotAtSignal,
  tradeNearSignal,
} from './observation-rules.js';
import {
  EVIDENCE_MAX_LAG_MS,
  type EligibilityClass,
  type MappingStatus,
} from './observation.constants.js';

export interface AssessInput {
  now: Date;
  t0: Date;
  /** CMC price at detection: identity check only. */
  cmcPrice: DValue;
  mapping: MappingStatus;
  mappingReasons: readonly string[];
  /** The pair's stored bars, ascending, covering at least [t0 − 1 h, min(window end, synced)). */
  bars: readonly Bar[];
  syncedUntilMs: number | null;
  /** First time LBank answered "currency pair nonsupport" for the pair (null = never / not since). */
  unsupportedSince: Date | null;
  /** LBank's Spot pairs list near the signal: listed, not listed, or no list (null). */
  spotListed: boolean | null;
  futures: ListingDecision;
  fetchError: string | null;
}

export interface Assessment {
  w: ObsWindow;
  entry: EntryResult;
  extremes: Extremes | null;
  cov: Coverage;
  spot: ReturnType<typeof spotAtSignal>;
  futures: ListingDecision;
  eligibility: EligibilityClass;
  status: StatusDecision;
  risePct: DValue | null;
  dropPct: DValue | null;
  /** SHA-256 of the bars the extremes rest on ([entry, observed through)); set when terminal. */
  seriesSha256: string | null;
}

/** Everything one observation shows, recomputed from its stored bars (docs § 5–6). Pure. */
export function assess(i: AssessInput): Assessment {
  const w = observationWindow(i.t0);
  const entry =
    i.mapping === 'OK' ? selectEntry(i.bars, w, i.syncedUntilMs) : ({ kind: 'pending' } as const);
  const cov = coverage(i.bars, w, i.syncedUntilMs);
  const extremes =
    entry.kind === 'ok' ? computeExtremes(i.bars, entry.bar.openMs, cov.observedThroughMs) : null;
  const unsupportedNearSignal =
    !!i.unsupportedSince && i.unsupportedSince.getTime() <= w.t0Ms + EVIDENCE_MAX_LAG_MS;
  const spot = spotAtSignal({
    listed: i.spotListed,
    unsupportedNearSignal,
    barBeforeT0: barBeforeSignal(i.bars, w),
    entryBar: entry.kind === 'ok',
    tradeNearSignal: tradeNearSignal(i.bars, w),
  });
  const eligibility = classifyEligibility(i.mapping, spot.status, i.futures.status);
  const status = observationStatus({
    nowMs: i.now.getTime(),
    w,
    mapping: i.mapping,
    mappingReasons: i.mappingReasons,
    spot,
    entry,
    entryDeviates: entry.kind === 'ok' && entryDeviatesFromCmc(entry.price, i.cmcPrice),
    cov,
    extremes,
    pairUnsupported: !!i.unsupportedSince,
    fetchError: i.fetchError,
  });
  const risePct = entry.kind === 'ok' && extremes ? pctChange(extremes.high, entry.price) : null;
  const dropPct = entry.kind === 'ok' && extremes ? pctChange(extremes.low, entry.price) : null;
  const seriesSha256 =
    status.terminal && entry.kind === 'ok'
      ? sha256(
          i.bars
            .filter((b) => b.openMs >= entry.bar.openMs && b.openMs < cov.observedThroughMs)
            .map(
              (b) =>
                `${b.openMs},${b.open.toFixed()},${b.high.toFixed()},${b.low.toFixed()},${b.close.toFixed()},${b.volume.toFixed()}`,
            )
            .join('\n'),
        )
      : null;
  return {
    w,
    entry,
    extremes,
    cov,
    spot,
    futures: i.futures,
    eligibility,
    status,
    risePct,
    dropPct,
    seriesSha256,
  };
}

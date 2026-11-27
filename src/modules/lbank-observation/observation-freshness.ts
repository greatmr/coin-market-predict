import { FUTURES_QUOTE_RULES_VERSION } from './futures-quote-rules.js';

/**
 * Display semantics of the observation's times and evidence (docs § 13b, ADR-0013). Pure functions:
 * no database. They label what the stored values already are; they never convert one kind of time
 * into another and never change a stored value.
 */

/**
 * What a Futures row's "through" time and its longest gap are measured in. Each method keeps its own
 * time base (never converted):
 *  - OUR_RESPONSE_RECEIVED (`lbank-futures-quote-1`): when our latest eligible response arrived;
 *  - LBANK_SNAPSHOT_TIME (`lbank-futures-sampled-1`): LBank's snapshot refresh time (`lastTime`) of the
 *    latest folded snapshot — LBank's time, not ours, and not the time of a trade.
 */
export type FuturesTimeBasis = 'OUR_RESPONSE_RECEIVED' | 'LBANK_SNAPSHOT_TIME';

export const FUTURES_TIME_BASIS_TEXT: Record<FuturesTimeBasis, string> = {
  OUR_RESPONSE_RECEIVED: 'when our latest eligible response was received (our clock)',
  LBANK_SNAPSHOT_TIME:
    'LBank’s snapshot refresh time (lastTime) of the latest folded snapshot — not a trade time',
};

export function futuresThrough(
  rulesVersion: string,
  sampledThrough: string | null,
): {
  basis: FuturesTimeBasis;
  observedThrough: string | null;
  lbankSnapshotThrough: string | null;
} {
  const observed = rulesVersion === FUTURES_QUOTE_RULES_VERSION;
  return {
    basis: observed ? 'OUR_RESPONSE_RECEIVED' : 'LBANK_SNAPSHOT_TIME',
    observedThrough: observed ? sampledThrough : null,
    lbankSnapshotThrough: observed ? null : sampledThrough,
  };
}

/**
 * The difference between the two venues' data-through times above which the page marks it: one
 * minute. Not a measurement rule (no value depends on it): Spot data is fetched in whole one-minute
 * candles and Futures is sampled once a minute, so a larger difference means one venue covers at
 * least one whole minute the other does not.
 */
export const COVERAGE_DIFF_VISIBLE_MS = 60_000;

export interface CoverageTimes {
  /** Spot: exclusive end of the one-minute candles fetched (verified trades lie before it). */
  spotDataThrough: string | null;
  spotLastFetchAt: string | null;
  /** Futures: in its own time base (`futuresBasis`). */
  futuresThrough: string | null;
  futuresBasis: FuturesTimeBasis | null;
  /** Futures through − Spot data through (ms); null when either is unknown. */
  differenceMs: number | null;
  /** |difference| > COVERAGE_DIFF_VISIBLE_MS: the venues' values cover visibly different spans. */
  differs: boolean;
}

export function coverageTimes(i: {
  spotDataThrough: string | null;
  spotLastFetchAt: string | null;
  futuresThrough: string | null;
  futuresBasis: FuturesTimeBasis | null;
}): CoverageTimes {
  const diff =
    i.spotDataThrough && i.futuresThrough
      ? Date.parse(i.futuresThrough) - Date.parse(i.spotDataThrough)
      : null;
  return {
    ...i,
    differenceMs: diff,
    differs: diff !== null && Math.abs(diff) > COVERAGE_DIFF_VISIBLE_MS,
  };
}

// ── Futures evidence class (Issue: old and new methods kept apart) ───────────────────────────

/**
 * What the stored records can establish about an observation's Futures entry, read-only:
 *  - IMMEDIATE_QUOTE: observed-quote method, first quote from the request fired at publication (or
 *    its prompt retry) — the only class counted as an immediate Futures entry;
 *  - TICK_QUOTE: observed-quote method, first quote from a minute sample (the publication request
 *    failed or lacked the contract): a valid observed quote, not an immediate one;
 *  - QUOTE_PENDING / NO_QUOTE: observed-quote method without a quote yet / at all;
 *  - NO_CONTRACT: no single LBank Futures contract for the CMC id (either method);
 *  - LEGACY_BEFORE_COLLECTION: old method, the window started before Futures collection existed;
 *  - LEGACY_FIRST_RESPONSE_RETAINED: old method, the first response our sampler received after the
 *    start was kept for the contract: the first observed price is establishable (a minute sample,
 *    not an immediate quote, its send time only bounded by the tick minute);
 *  - LEGACY_FIRST_RESPONSE_LOST: old method, that response was not kept for the contract (storage
 *    defect fixed 2026-11-27): the first observed price cannot be reconstructed;
 *  - LEGACY_UNRESOLVED: old method, no successful response after the start found.
 */
export const FUTURES_EVIDENCE_CLASSES = [
  'IMMEDIATE_QUOTE',
  'TICK_QUOTE',
  'QUOTE_PENDING',
  'NO_QUOTE',
  'NO_CONTRACT',
  'LEGACY_BEFORE_COLLECTION',
  'LEGACY_FIRST_RESPONSE_RETAINED',
  'LEGACY_FIRST_RESPONSE_LOST',
  'LEGACY_UNRESOLVED',
] as const;
export type FuturesEvidenceClass = (typeof FUTURES_EVIDENCE_CLASSES)[number];

export interface FuturesEvidenceInput {
  rulesVersion: string;
  mapping: string;
  contract: string | null;
  status: string;
  /** Observed-quote method: the request that produced the first quote. */
  entrySource: string | null;
  startMs: number | null;
  /** The first successful Futures request ever stored (when collection began). */
  firstPollMs: number | null;
  /** Old method: the first successful response after the start, and whether the contract's row was kept. */
  legacyFirst: { retained: boolean } | null;
}

export function futuresEvidence(i: FuturesEvidenceInput): {
  evidenceClass: FuturesEvidenceClass;
  immediateEntry: boolean;
} {
  const out = (c: FuturesEvidenceClass) => ({
    evidenceClass: c,
    immediateEntry: c === 'IMMEDIATE_QUOTE',
  });
  if (['NONE', 'AMBIGUOUS'].includes(i.mapping)) return out('NO_CONTRACT');
  if (i.rulesVersion === FUTURES_QUOTE_RULES_VERSION) {
    if (i.entrySource === 'PUBLICATION' || i.entrySource === 'RETRY') return out('IMMEDIATE_QUOTE');
    if (i.entrySource === 'TICK') return out('TICK_QUOTE');
    return out(
      ['NO_REFERENCE', 'MAPPING_UNKNOWN', 'MAPPING_AMBIGUOUS', 'NO_CONTRACT'].includes(i.status)
        ? 'NO_QUOTE'
        : 'QUOTE_PENDING',
    );
  }
  if (i.startMs !== null && (i.firstPollMs === null || i.startMs < i.firstPollMs))
    return out('LEGACY_BEFORE_COLLECTION');
  if (!i.contract) return out('NO_CONTRACT');
  if (!i.legacyFirst) return out('LEGACY_UNRESOLVED');
  return out(
    i.legacyFirst.retained ? 'LEGACY_FIRST_RESPONSE_RETAINED' : 'LEGACY_FIRST_RESPONSE_LOST',
  );
}

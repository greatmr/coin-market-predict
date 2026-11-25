import type { ObsEvent } from './entities/obs-event.entity.js';
import { observationWindow, type resolveSpotPair } from './observation-rules.js';
import type { ActionableTiming } from './observation-timing.js';
import { FINALIZE_RETRY_MS, OBSERVATION_RULES_VERSION } from './observation.constants.js';

/** Column values of new and re-timed observations, shared by the intake and the job. */

/** The columns a proven start sets (window, retry horizon, expected minutes). */
export function timingValues(timing: ActionableTiming, extra: Record<string, unknown> = {}) {
  const w = observationWindow(timing.at);
  return {
    actionableAt: timing.at,
    actionableSource: timing.source,
    actionableEvidence: { ...timing.evidence, uncertain: timing.uncertain, ...extra } as never,
    observationStart: timing.at,
    observationEnd: new Date(w.endMs),
    retryUntil: new Date(w.endMs + FINALIZE_RETRY_MS),
    minutesExpected: w.minutes,
  };
}

/** A new (rules v2) observation row of an event; its start is set by the caller or the job. */
export function newObservationValues(
  e: Pick<ObsEvent, 'id' | 'isLive' | 'detectedAt'>,
  providerId: string,
  pairId: number | null,
  mapping: ReturnType<typeof resolveSpotPair>,
  now: Date,
) {
  return {
    eventId: e.id,
    providerId,
    isLive: e.isLive,
    t0: e.detectedAt,
    // Rules v1 audit column (t0 + 168 h), kept for every row; the v2 window is observation_start/end.
    windowEnd: new Date(e.detectedAt.getTime() + 168 * 3_600_000),
    pairId,
    pairSymbol: mapping.symbol,
    quoteAsset: mapping.quote,
    mappingStatus: mapping.status,
    mappingEvidence: {
      ...mapping.evidence,
      reasons: mapping.reasons,
      decidedAt: now.toISOString(),
    } as never,
    spotStatus: 'UNKNOWN' as const,
    spotTrading: null,
    futuresStatus: 'UNKNOWN' as const,
    eligibility: 'PENDING' as const,
    eligibilityEvidence: {} as never,
    expectedBars: null,
    coveredBars: null,
    tradedBars: null,
    missingBars: null,
    missingRanges: null,
    startUnobservedMs: null,
    boundaryUnobservedMs: null,
    status: 'ACTIVE' as const,
    reasons: mapping.reasons,
    rulesVersion: OBSERVATION_RULES_VERSION,
    resultVersion: 0,
    referenceStatus: 'PENDING' as const,
  };
}

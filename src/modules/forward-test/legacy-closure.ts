import type { DValue } from '../../common/utils/decimal.js';

import {
  type ForwardEventStatus,
  MISSING_DATA_RETRY_DAYS,
  type PeakKind,
  FORWARD_REASON as R,
} from './forward.constants.js';

/**
 * Terminal outcomes of the legacy forward test after the cutover (docs/forward-test.md § 15,
 * docs/adr/0009-lbank-spot-observation.md). The legacy tracker keeps following its pre-cutover
 * events with its own rules; this only decides when an event has nothing left to wait for, and
 * says so explicitly — a data failure is recorded as such, never as a result. Pure.
 *
 * - FINAL: the event's own status is FINAL (every included High present, day 0 settled).
 * - INCOMPLETE: the window closed and the missing-data retries are over, with a confirmed but
 *   lower-bound peak (a missing or invalid day, or an unresolved signal day): kept as a lower
 *   bound, never a final result.
 * - DATA_UNAVAILABLE: the retries are over and no confirmed High exists, or the last check failed.
 *
 * Retries end MISSING_DATA_RETRY_DAYS after `evaluation_end`, as in the daily update itself.
 */
export const LEGACY_CLOSURE_RULES_VERSION = 'legacy-closure-1';

export const LEGACY_CLOSURES = ['FINAL', 'INCOMPLETE', 'DATA_UNAVAILABLE'] as const;
export type LegacyClosure = (typeof LEGACY_CLOSURES)[number];

const DAY_MS = 86_400_000;

export interface LegacyEventState {
  status: ForwardEventStatus;
  evaluationEnd: Date;
  lastCheckStatus: string | null;
  lastCheckNote: string | null;
}

export interface LegacyOutcomeState {
  resultVersion: number;
  peakKind: PeakKind;
  peakReturnPct: DValue | null;
  missingDates: readonly string[];
  invalidDates: readonly string[];
  reasons: readonly string[];
}

export type LegacyClosureDecision =
  | {
      terminal: true;
      closure: LegacyClosure;
      reasons: string[];
    }
  | {
      terminal: false;
      /** When the event becomes terminal at the latest (end of the missing-data retries). */
      terminalBy: Date;
      waitingFor: string;
    };

export function retryHorizonEnd(evaluationEnd: Date): Date {
  return new Date(evaluationEnd.getTime() + MISSING_DATA_RETRY_DAYS * DAY_MS);
}

export function legacyClosure(
  e: LegacyEventState,
  o: LegacyOutcomeState | null,
  now: Date,
): LegacyClosureDecision {
  if (e.status === 'FINAL') return { terminal: true, closure: 'FINAL', reasons: [] };
  const horizon = retryHorizonEnd(e.evaluationEnd);
  if (now.getTime() <= horizon.getTime())
    return {
      terminal: false,
      terminalBy: horizon,
      waitingFor:
        now.getTime() <= e.evaluationEnd.getTime()
          ? 'window open'
          : `missing-data retries until ${horizon.toISOString()}`,
    };
  const reasons = [
    `STATUS:${e.status}`,
    ...(o?.missingDates ?? []).map((d) => `${R.highMissing}:${d}`),
    ...(o?.invalidDates ?? []).map((d) => `${R.highInvalid}:${d}`),
    ...(o?.reasons ?? []).filter((r) => r !== R.highMissing && r !== R.highInvalid),
  ];
  if (e.lastCheckStatus === 'RETRIEVAL_ERROR') reasons.push('LAST_CHECK:RETRIEVAL_ERROR');
  if (!o) reasons.push('NO_OUTCOME');
  const confirmed =
    !!o &&
    o.peakKind !== 'NONE' &&
    o.peakReturnPct !== null &&
    e.lastCheckStatus !== 'RETRIEVAL_ERROR';
  return {
    terminal: true,
    closure: confirmed ? 'INCOMPLETE' : 'DATA_UNAVAILABLE',
    reasons: [...new Set(reasons)],
  };
}

export interface RetirementCheck {
  ready: boolean;
  events: number;
  terminal: number;
  pending: number;
  /** The latest time any pending event becomes terminal. */
  pendingUntil: Date | null;
  why: string;
}

/**
 * The legacy tracker can retire only after the cutover has passed (no new legacy event can arrive)
 * and every legacy event is terminal.
 */
export function retirementCheck(input: {
  cutoverPassed: boolean;
  decisions: readonly LegacyClosureDecision[];
}): RetirementCheck {
  const pending = input.decisions.filter((d) => !d.terminal);
  const until = pending.reduce<Date | null>(
    (m, d) => (d.terminal ? m : !m || d.terminalBy > m ? d.terminalBy : m),
    null,
  );
  const base = {
    events: input.decisions.length,
    terminal: input.decisions.length - pending.length,
    pending: pending.length,
    pendingUntil: until,
  };
  if (!input.cutoverPassed)
    return {
      ...base,
      ready: false,
      why: 'no cutover has passed: the legacy tracker still takes new events',
    };
  if (pending.length)
    return { ...base, ready: false, why: `${pending.length} legacy events are not terminal yet` };
  return { ...base, ready: true, why: 'every legacy event has a terminal outcome' };
}

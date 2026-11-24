import { describe, expect, it } from 'vitest';

import { D } from '../../common/utils/decimal.js';

import {
  type LegacyEventState,
  type LegacyOutcomeState,
  legacyClosure,
  retirementCheck,
  retryHorizonEnd,
} from './legacy-closure.js';

const t = (s: string) => new Date(s);
const evaluationEnd = t('2026-11-27T23:59:59.999Z');
const ev = (
  status: LegacyEventState['status'],
  extra: Partial<LegacyEventState> = {},
): LegacyEventState => ({
  status,
  evaluationEnd,
  lastCheckStatus: 'UNCHANGED',
  lastCheckNote: null,
  ...extra,
});
const outcome = (extra: Partial<LegacyOutcomeState> = {}): LegacyOutcomeState => ({
  resultVersion: 4,
  peakKind: 'LOWER_BOUND',
  peakReturnPct: new D('12.5'),
  missingDates: [],
  invalidDates: [],
  reasons: [],
  ...extra,
});

describe('legacy closure (terminal outcome of a pre-cutover event)', () => {
  it('a FINAL event is terminal at once', () => {
    expect(
      legacyClosure(ev('FINAL'), outcome({ peakKind: 'EXACT' }), t('2026-11-28T01:00:00Z')),
    ).toEqual({
      terminal: true,
      closure: 'FINAL',
      reasons: [],
    });
  });

  it('waits while the window is open, then through the missing-data retries (3 days after evaluation_end)', () => {
    const open = legacyClosure(ev('TRACKING'), outcome(), t('2026-11-25T00:00:00Z'));
    expect(open).toMatchObject({ terminal: false, waitingFor: 'window open' });
    const horizon = retryHorizonEnd(evaluationEnd);
    expect(horizon.toISOString()).toBe('2026-11-30T23:59:59.999Z');
    const retrying = legacyClosure(ev('INCOMPLETE'), outcome(), horizon);
    expect(retrying).toMatchObject({ terminal: false, terminalBy: horizon });
  });

  it('after the retries: a confirmed lower-bound peak closes as INCOMPLETE with its reasons', () => {
    const d = legacyClosure(
      ev('INCOMPLETE'),
      outcome({ missingDates: ['2026-11-24'], reasons: ['HIGH_MISSING', 'INCOMPLETE_DAY0'] }),
      t('2026-12-01T00:00:00Z'),
    );
    expect(d).toEqual({
      terminal: true,
      closure: 'INCOMPLETE',
      reasons: ['STATUS:INCOMPLETE', 'HIGH_MISSING:2026-11-24', 'INCOMPLETE_DAY0'],
    });
  });

  it('after the retries: no confirmed High, no outcome or a failed last check is DATA_UNAVAILABLE, never a result', () => {
    const late = t('2026-12-01T00:00:00Z');
    expect(
      legacyClosure(
        ev('AWAITING_FINAL_DAY'),
        outcome({ peakKind: 'NONE', peakReturnPct: null }),
        late,
      ),
    ).toMatchObject({
      closure: 'DATA_UNAVAILABLE',
    });
    expect(legacyClosure(ev('OPEN'), null, late)).toMatchObject({
      closure: 'DATA_UNAVAILABLE',
      reasons: ['STATUS:OPEN', 'NO_OUTCOME'],
    });
    expect(
      legacyClosure(ev('INCOMPLETE', { lastCheckStatus: 'RETRIEVAL_ERROR' }), outcome(), late),
    ).toMatchObject({
      closure: 'DATA_UNAVAILABLE',
      reasons: expect.arrayContaining(['LAST_CHECK:RETRIEVAL_ERROR']),
    });
  });

  it('retires only after a cutover has passed and every event is terminal', () => {
    const fin = legacyClosure(
      ev('FINAL'),
      outcome({ peakKind: 'EXACT' }),
      t('2026-12-01T00:00:00Z'),
    );
    const pend = legacyClosure(ev('TRACKING'), outcome(), t('2026-11-26T00:00:00Z'));
    expect(retirementCheck({ cutoverPassed: false, decisions: [fin] })).toMatchObject({
      ready: false,
    });
    expect(retirementCheck({ cutoverPassed: true, decisions: [fin, pend] })).toMatchObject({
      ready: false,
      pending: 1,
      terminal: 1,
      pendingUntil: t('2026-11-30T23:59:59.999Z'),
    });
    expect(retirementCheck({ cutoverPassed: true, decisions: [fin] })).toMatchObject({
      ready: true,
      events: 1,
    });
    // No legacy events at all (e.g. a fresh install): nothing to wait for once the cutover passed.
    expect(retirementCheck({ cutoverPassed: true, decisions: [] })).toMatchObject({
      ready: true,
      events: 0,
    });
  });
});

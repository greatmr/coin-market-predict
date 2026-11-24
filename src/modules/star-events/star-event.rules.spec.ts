import { describe, expect, it } from 'vitest';

import { cutoverProblem, detectedUtcDate, isUtcMidnight, workflowFor } from './star-event.rules.js';

const t = (s: string) => new Date(s);
const H = 3_600_000;

describe('routing between the legacy forward test and the LBank observation', () => {
  const cutover = t('2026-11-26T00:00:00.000Z');

  it('keeps every sighting legacy while no cutover is set', () => {
    expect(workflowFor(null, t('2030-01-01T00:00:00Z'))).toBe('LEGACY_FORWARD');
  });

  it('routes exactly at the cutover instant to the LBank observation, one millisecond earlier to legacy', () => {
    expect(workflowFor(cutover, t('2026-11-25T23:59:59.999Z'))).toBe('LEGACY_FORWARD');
    expect(workflowFor(cutover, t('2026-11-26T00:00:00.000Z'))).toBe('LBANK_OBSERVATION');
    expect(workflowFor(cutover, t('2026-11-26T00:07:00.045Z'))).toBe('LBANK_OBSERVATION');
  });

  it('a UTC-midnight cutover never splits one event key (same UTC date) across both trackers', () => {
    // Every sighting of one key shares its UTC date, so all of them land on the same side.
    for (const at of ['2026-11-25T00:07:00Z', '2026-11-25T13:07:00Z', '2026-11-25T23:59:59.999Z'])
      expect(workflowFor(cutover, t(at))).toBe('LEGACY_FORWARD');
    for (const at of ['2026-11-26T00:00:00Z', '2026-11-26T13:07:00Z', '2026-11-26T23:59:59.999Z'])
      expect(workflowFor(cutover, t(at))).toBe('LBANK_OBSERVATION');
    expect(detectedUtcDate(t('2026-11-25T23:59:59.999Z'))).toBe('2026-11-25');
    expect(detectedUtcDate(t('2026-11-26T00:00:00.000Z'))).toBe('2026-11-26');
  });
});

describe('cutover validation', () => {
  const now = t('2026-11-24T14:00:00Z');
  const base = {
    current: null,
    now,
    latestBatchCrawledAt: t('2026-11-24T13:07:00Z'),
    minLeadMs: 2 * H,
  };

  it('accepts a future UTC midnight after every stored batch', () => {
    expect(cutoverProblem({ ...base, requested: t('2026-11-25T00:00:00Z') })).toBeNull();
  });

  it('refuses a time that is not exactly 00:00:00.000 UTC', () => {
    expect(isUtcMidnight(t('2026-11-25T00:00:00.001Z'))).toBe(false);
    expect(cutoverProblem({ ...base, requested: t('2026-11-25T00:00:00.001Z') })).toMatch(
      /00:00:00.000 UTC/,
    );
    expect(cutoverProblem({ ...base, requested: t('2026-11-25T03:30:00Z') })).toMatch(/UTC/);
  });

  it('refuses a past or too-close cutover, and one at or before a stored batch', () => {
    expect(cutoverProblem({ ...base, requested: t('2026-11-24T00:00:00Z') })).toMatch(/future/);
    expect(
      cutoverProblem({
        ...base,
        now: t('2026-11-24T22:30:00Z'),
        latestBatchCrawledAt: null,
        requested: t('2026-11-25T00:00:00Z'),
      }),
    ).toMatch(/future/);
    expect(
      cutoverProblem({
        ...base,
        latestBatchCrawledAt: t('2026-11-26T00:07:00Z'),
        requested: t('2026-11-26T00:00:00Z'),
      }),
    ).toMatch(/batch/);
  });

  it('moves an existing cutover only while it is still ahead; never once it has passed', () => {
    expect(
      cutoverProblem({
        ...base,
        current: t('2026-11-26T00:00:00Z'),
        requested: t('2026-11-27T00:00:00Z'),
      }),
    ).toBeNull();
    expect(
      cutoverProblem({
        ...base,
        current: t('2026-11-24T00:00:00Z'),
        requested: t('2026-11-27T00:00:00Z'),
      }),
    ).toMatch(/can no longer change/);
  });
});

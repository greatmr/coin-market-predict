import { describe, expect, it } from 'vitest';

import { parseOverrides } from './overrides.js';

describe('versioned override list (p.9, p.18)', () => {
  const text = JSON.stringify({
    version: 'v7',
    updatedAt: '2026-11-05T00:00:00.000Z',
    classOverrides: [
      {
        cmcId: 7,
        class: 'eligible',
        reason: 'governance token, not wrapped',
        addedBy: 'op',
        addedAt: '2026-11-05',
      },
    ],
    lbankMappingOverrides: [
      {
        cmcId: 8,
        marketPair: 'ABCX/USDT',
        decision: 'MAPPING_CONFIRMED',
        reason: 'same contract',
        addedBy: 'op',
        addedAt: '2026-11-05',
      },
    ],
  });
  it('parses, versions and applies entries; rejects unknown fields', () => {
    const o = parseOverrides(text);
    expect(o.version).toBe('v7');
    expect(o.classFor('fixture', 7)).toEqual({
      class: 'eligible',
      reason: 'governance token, not wrapped',
      version: 'v7',
    });
    expect(o.lbankDecisionsFor('fixture', 8)[0]).toMatchObject({
      marketPair: 'ABCX/USDT',
      decision: 'MAPPING_CONFIRMED',
      source: 'overrides_file',
    });
    expect(() =>
      parseOverrides(
        JSON.stringify({ version: 'x', updatedAt: '2026-11-05T00:00:00.000Z', extra: 1 }),
      ),
    ).toThrow(/invalid overrides/);
  });
});

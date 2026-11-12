import { describe, expect, it } from 'vitest';

import type { CoinAnalysis } from './agent.schemas.js';
import { applyGuardrails } from './guardrails.js';

const analysis = (over: Partial<CoinAnalysis> = {}): CoinAnalysis => ({
  outlook: 'PUMP_LIKELY',
  confidence: 'HIGH',
  headline: 'Volume is arriving before price.',
  mindset: 'I see a setup.',
  strategyFit: 'Three stars.',
  bullishFactors: [],
  bearishFactors: [],
  risks: [],
  dataGaps: [],
  watchNext: [],
  candleState: 'PRE_MOVE',
  marketRegime: 'FAVORABLE',
  ...over,
});
const live = { isLive: true, currentStatus: 'OK', batchStatus: 'COMPLETE' };

describe('confidence guardrails (in code, not in the prompt)', () => {
  it('leaves a view on complete, live, current data untouched', () => {
    expect(applyGuardrails(analysis(), live)).toEqual({ analysis: analysis(), notes: [] });
  });

  it('caps confidence at LOW on synthetic data or without a valid current observation', () => {
    const fixture = applyGuardrails(analysis(), { ...live, isLive: false });
    expect(fixture.analysis.confidence).toBe('LOW');
    expect(fixture.notes[0]).toMatch(/synthetic fixture/);
    const stale = applyGuardrails(analysis({ confidence: 'MEDIUM' }), {
      ...live,
      currentStatus: 'STALE',
    });
    expect(stale.analysis.confidence).toBe('LOW');
    expect(stale.notes[0]).toMatch(/STALE/);
  });

  it('caps confidence at MEDIUM on an incomplete batch, and never changes the outlook', () => {
    const r = applyGuardrails(analysis(), { ...live, batchStatus: 'INCOMPLETE' });
    expect([r.analysis.confidence, r.analysis.outlook]).toEqual(['MEDIUM', 'PUMP_LIKELY']);
    expect(
      applyGuardrails(analysis({ confidence: 'LOW' }), { ...live, isLive: false }).notes,
    ).toEqual([]);
  });
});

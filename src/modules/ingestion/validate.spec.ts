import { describe, expect, it } from 'vitest';

import type { RawObservation } from '../sources/source.types.js';

import { normalizeContract, sanitizeText, validateObservation } from './validate.js';

const slot = new Date('2026-11-03T12:00:00Z');
const collectedAt = new Date('2026-11-03T12:07:00Z');
const opts = { slotTime: slot, collectedAt, staleAfterMinutes: 90 };

const raw = (o: Partial<RawObservation> = {}): RawObservation => ({
  providerAssetId: 'x',
  name: 'X',
  symbol: 'x',
  sourceUrl: 'https://example.invalid/x',
  observedAt: new Date('2026-11-03T12:03:00Z'),
  price: 2,
  marketCap: 2_000_000,
  fullyDilutedValuation: 9_000_000,
  circulatingSupply: 1_000_000,
  volume24h: 500_000,
  ...o,
});

describe('observation validation', () => {
  it('keeps a complete, fresh observation', () => {
    const d = validateObservation(raw(), opts);
    expect(d.isStale).toBe(false);
    expect(d.completeness).toBe(1);
    expect(d.marketCapProvenance).toBe('provider_reported');
    expect(d.freshnessSeconds).toBe(240);
  });

  it('calculates market cap from circulating supply when missing and labels provenance', () => {
    const d = validateObservation(raw({ marketCap: 0 }), opts);
    expect(d.marketCap).toBe(2_000_000);
    expect(d.marketCapProvenance).toBe('calculated_from_circulating_supply');
    expect(d.qualityFlags).toContain('market_cap_calculated');
  });

  it('never substitutes fully diluted valuation for market cap', () => {
    const d = validateObservation(raw({ marketCap: null, circulatingSupply: null }), opts);
    expect(d.marketCap).toBeNull();
    expect(d.marketCapProvenance).toBe('unavailable');
    expect(d.fullyDilutedValuation).toBe(9_000_000);
    expect(d.nullReasons.marketCap).toMatch(/FDV is never substituted/);
  });

  it('keeps rolling 24h volume separate and never derives hourly volume', () => {
    const d = validateObservation(raw(), opts);
    expect(d.volumeRolling24h).toBe(500_000);
    expect(d.volumeHourly).toBeNull();
    expect(d.nullReasons.volumeHourly).toMatch(/not derived from differences/);
  });

  it('flags stale and unknown observation times', () => {
    expect(
      validateObservation(raw({ observedAt: new Date('2026-11-03T09:00:00Z') }), opts).isStale,
    ).toBe(true);
    const u = validateObservation(raw({ observedAt: null }), opts);
    expect(u.isStale).toBe(true);
    expect(u.qualityFlags).toContain('unknown_observation_time');
  });

  it('treats invalid prices as missing with a reason', () => {
    const d = validateObservation(raw({ price: -1 }), opts);
    expect(d.price).toBeNull();
    expect(d.nullReasons.price).toMatch(/invalid/);
  });

  it('sanitizes untrusted names and symbols', () => {
    expect(sanitizeText('Weird\u0007 Token ‮evil', 120)).toBe('Weird Token evil');
    expect(sanitizeText('x'.repeat(500), 32)).toHaveLength(32);
  });

  it('normalizes EVM contracts case-insensitively but leaves other chains intact', () => {
    expect(
      normalizeContract('Ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48').contractAddress,
    ).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(
      normalizeContract('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').contractAddress,
    ).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });
});

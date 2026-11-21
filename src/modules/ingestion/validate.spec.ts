import { getMetadataArgsStorage } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { ScanResult } from '../scan/entities/scan-result.entity.js';
import type { RawObservation } from '../sources/source.types.js';

import { MarketSnapshot } from './entities/market-snapshot.entity.js';
import {
  SNAPSHOT_NUMERIC_RANGE,
  fitsNumeric,
  normalizeContract,
  sanitizeText,
  validateObservation,
} from './validate.js';

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

describe('storable range (numeric field overflow, 22003)', () => {
  it('stores a coin whose provider % change cannot fit numeric(20,8) with that field NULL', () => {
    // CMC id 30826 ($MICRO) on 2026-11-21: this quote failed four hourly batches in a row.
    const d = validateObservation(
      raw({
        price: 411209811213.1216,
        marketCap: 308196071818273100000,
        circulatingSupply: 749486183,
        changePct1h: 4816422969501060,
        changePct24h: 765791666794190200,
        changePct7d: 715739162424646500,
      }),
      opts,
    );
    expect(d.providerChangePct1h).toBeNull();
    expect(d.providerChangePct24h).toBeNull();
    expect(d.providerChangePct7d).toBeNull();
    expect(d.nullReasons.providerChangePct1h).toMatch(
      /outside the storable range \(\|x\| < 1e12\)/,
    );
    expect(d.qualityFlags.filter((f) => f === 'value_out_of_range')).toHaveLength(1);
    expect(d.price).toBe(411209811213.1216);
    expect(d.marketCap).toBe(308196071818273100000);
    expect(d.completeness).toBe(1);
  });

  it('keeps the largest value that fits and rejects values that round past the limit', () => {
    expect(fitsNumeric(999999999999.9999, 12, 8)).toBe(true);
    expect(fitsNumeric(-999999999999.9999, 12, 8)).toBe(true);
    expect(fitsNumeric(1e12, 12, 8)).toBe(false);
    expect(fitsNumeric(-1e12, 12, 8)).toBe(false);
    expect(fitsNumeric(9.99994, 1, 4)).toBe(true);
    expect(fitsNumeric(9.99995, 1, 4)).toBe(false); // PostgreSQL rounds it to 10.0000
    expect(fitsNumeric(1e-30, 20, 18)).toBe(true); // rounds to 0, which fits
  });

  it('never replaces an out-of-range reported market cap with a calculated one', () => {
    const d = validateObservation(raw({ marketCap: 1e31 }), opts);
    expect(d.marketCap).toBeNull();
    expect(d.marketCapProvenance).toBe('unavailable');
    expect(d.nullReasons.marketCap).toMatch(/outside the storable range/);
    expect(d.qualityFlags).toEqual(
      expect.arrayContaining(['value_out_of_range', 'missing_market_cap']),
    );
  });

  it('nulls an out-of-range price, supply and volume as missing core fields', () => {
    const d = validateObservation(
      raw({ price: 1e20, circulatingSupply: 1e30, volume24h: 1e30, marketCap: null }),
      opts,
    );
    expect(d.price).toBeNull();
    expect(d.circulatingSupply).toBeNull();
    expect(d.volumeRolling24h).toBeNull();
    expect(d.marketCap).toBeNull();
    expect(d.nullReasons.price).toMatch(/outside the storable range/);
    expect(d.qualityFlags).toEqual(
      expect.arrayContaining(['missing_price', 'missing_volume', 'missing_market_cap']),
    );
    expect(d.completeness).toBe(0.2);
  });

  it('matches the entity columns it guards', () => {
    const numeric = (target: object, prop: string) => {
      const c = getMetadataArgsStorage().columns.find(
        (x) => x.target === target && x.propertyName === prop,
      );
      expect(c, prop).toBeDefined();
      return { digits: c!.options.precision! - c!.options.scale!, scale: c!.options.scale! };
    };
    for (const [field, [digits, scale]] of Object.entries(SNAPSHOT_NUMERIC_RANGE)) {
      const col = numeric(MarketSnapshot, field);
      expect(col.scale, field).toBe(scale);
      expect(digits, field).toBeLessThanOrEqual(col.digits);
    }
    // Market cap and 24h volume are copied into the scan result, which holds fewer digits.
    expect(SNAPSHOT_NUMERIC_RANGE.marketCap[0]).toBe(numeric(ScanResult, 'capUsd').digits);
    expect(SNAPSHOT_NUMERIC_RANGE.volumeRolling24h[0]).toBe(
      numeric(ScanResult, 'volume24hUsd').digits,
    );
    expect(SNAPSHOT_NUMERIC_RANGE.price[0]).toBeLessThanOrEqual(
      numeric(ScanResult, 'priceUsd').digits,
    );
  });
});

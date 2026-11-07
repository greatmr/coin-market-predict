import type { RawObservation } from '../sources/source.types.js';

export const MARKET_CAP_PROVENANCES = [
  'provider_reported',
  'calculated_from_circulating_supply',
  'unavailable',
] as const;
export type MarketCapProvenance = (typeof MARKET_CAP_PROVENANCES)[number];
export const SUPPLY_PROVENANCES = ['provider_reported', 'unavailable'] as const;
export type SupplyProvenance = (typeof SUPPLY_PROVENANCES)[number];

/** Validated, normalized observation ready to persist. Numbers remain JS numbers here. */
export interface SnapshotDraft {
  providerAssetId: string;
  name: string;
  symbol: string;
  sourceUrl: string;
  slotTime: Date;
  collectedAt: Date;
  observedAt: Date | null;
  quoteCurrency: 'USD';
  price: number | null;
  marketCap: number | null;
  marketCapProvenance: MarketCapProvenance;
  fullyDilutedValuation: number | null;
  circulatingSupply: number | null;
  supplyProvenance: SupplyProvenance;
  volumeRolling24h: number | null;
  volumeHourly: number | null;
  volumeHourlySource: string | null;
  providerChangePct1h: number | null;
  providerChangePct24h: number | null;
  providerChangePct7d: number | null;
  bidAskSpreadPct: number | null;
  depthPlus2PctUsd: number | null;
  depthMinus2PctUsd: number | null;
  liquiditySource: string | null;
  /** Provider rank (CMC `cmcRank`). */
  rank: number | null;
  /** Provider first-listing date (CMC `dateAdded`). */
  dateAdded: Date | null;
  /** Raw provider tags, sanitized. */
  tags: string[];
  qualityFlags: string[];
  completeness: number;
  freshnessSeconds: number | null;
  isStale: boolean;
  nullReasons: Record<string, string>;
}

export interface ValidateOptions {
  slotTime: Date;
  collectedAt: Date;
  staleAfterMinutes: number;
}

const CORE_FIELDS = [
  'price',
  'marketCap',
  'volumeRolling24h',
  'circulatingSupply',
  'observedAt',
] as const;

/** C0/C1 controls and bidirectional overrides/isolates (they can disguise a symbol). */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_CHARS = /[\u0000-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]/g;

/** Strip control characters and cap length: names/symbols are untrusted source text. */
export function sanitizeText(input: string, maxLen: number): string {
  return input.replace(UNSAFE_TEXT_CHARS, '').trim().slice(0, maxLen);
}

function finitePositive(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function validateObservation(raw: RawObservation, opts: ValidateOptions): SnapshotDraft {
  const flags: string[] = [];
  const nullReasons: Record<string, string> = {};

  const price = finitePositive(raw.price);
  if (price === null) {
    nullReasons.price =
      raw.price === null || raw.price === undefined
        ? 'not reported by source'
        : `invalid value (${raw.price})`;
    flags.push('missing_price');
  }

  // Circulating supply
  const supply = finitePositive(raw.circulatingSupply);
  if (supply === null) {
    nullReasons.circulatingSupply =
      raw.circulatingSupply === 0 ? 'source reported 0 (unknown)' : 'not reported by source';
  }

  // Market cap: provider circulating cap first; else calculate from circulating supply. Never FDV.
  let marketCap = finitePositive(raw.marketCap);
  let marketCapProvenance: MarketCapProvenance = 'provider_reported';
  if (marketCap === null) {
    if (price !== null && supply !== null) {
      marketCap = price * supply;
      marketCapProvenance = 'calculated_from_circulating_supply';
      flags.push('market_cap_calculated');
    } else {
      marketCapProvenance = 'unavailable';
      nullReasons.marketCap =
        raw.marketCap === 0
          ? 'source reported 0 (unknown) and circulating supply unavailable; FDV is never substituted'
          : 'not reported and circulating supply unavailable; FDV is never substituted';
      flags.push('missing_market_cap');
    }
  }

  const volume24h = finiteOrNull(raw.volume24h);
  if (volume24h === null || volume24h < 0) {
    nullReasons.volumeRolling24h = 'not reported by source';
    flags.push('missing_volume');
  }

  const volumeHourly = finiteOrNull(raw.volumeHourly ?? null);
  if (volumeHourly === null) {
    nullReasons.volumeHourly =
      'source provides rolling 24h volume only; hourly volume is not derived from differences of overlapping 24h totals';
  }

  // Freshness
  let freshnessSeconds: number | null = null;
  let isStale = false;
  if (raw.observedAt) {
    freshnessSeconds = Math.round((opts.collectedAt.getTime() - raw.observedAt.getTime()) / 1000);
    if (freshnessSeconds > opts.staleAfterMinutes * 60) {
      isStale = true;
      flags.push('stale_observation');
    }
    if (freshnessSeconds < -300) flags.push('observation_in_future');
  } else {
    nullReasons.observedAt = 'source did not report an observation time';
    flags.push('unknown_observation_time');
    isStale = true;
  }

  if (marketCap !== null && volume24h !== null && volume24h > marketCap * 2)
    flags.push('volume_exceeds_2x_market_cap');

  const present = CORE_FIELDS.filter((f) => {
    switch (f) {
      case 'price':
        return price !== null;
      case 'marketCap':
        return marketCap !== null;
      case 'volumeRolling24h':
        return volume24h !== null;
      case 'circulatingSupply':
        return supply !== null;
      case 'observedAt':
        return raw.observedAt !== null;
    }
  }).length;

  const rank =
    typeof raw.rank === 'number' && Number.isSafeInteger(raw.rank) && raw.rank > 0
      ? raw.rank
      : null;
  if (rank === null)
    nullReasons.rank =
      raw.rank === undefined ? 'source does not report a rank' : 'not reported for this asset';
  const dateAdded =
    raw.dateAdded instanceof Date && Number.isFinite(raw.dateAdded.getTime())
      ? raw.dateAdded
      : null;
  if (dateAdded === null)
    nullReasons.dateAdded =
      raw.dateAdded === undefined
        ? 'source does not report a listing date'
        : 'not reported for this asset';
  const tags = [
    ...new Set(
      (raw.tags ?? [])
        .filter((t) => typeof t === 'string')
        .map((t) => sanitizeText(t, 64))
        .filter(Boolean),
    ),
  ].slice(0, 200);

  const fdv = finitePositive(raw.fullyDilutedValuation);
  if (fdv === null) nullReasons.fullyDilutedValuation = 'not reported by source';

  const liquidity = {
    bidAskSpreadPct: finiteOrNull(raw.bidAskSpreadPct ?? null),
    depthPlus2PctUsd: finiteOrNull(raw.depthPlus2PctUsd ?? null),
    depthMinus2PctUsd: finiteOrNull(raw.depthMinus2PctUsd ?? null),
  };
  if (liquidity.bidAskSpreadPct === null)
    nullReasons.bidAskSpreadPct = 'source listing endpoint does not provide spread';
  if (liquidity.depthPlus2PctUsd === null)
    nullReasons.depthPlus2PctUsd = 'source listing endpoint does not provide depth';

  return {
    providerAssetId: raw.providerAssetId,
    name: sanitizeText(raw.name, 120),
    symbol: sanitizeText(raw.symbol, 32).toUpperCase(),
    sourceUrl: raw.sourceUrl,
    slotTime: opts.slotTime,
    collectedAt: opts.collectedAt,
    observedAt: raw.observedAt,
    quoteCurrency: 'USD',
    price,
    marketCap,
    marketCapProvenance,
    fullyDilutedValuation: fdv,
    circulatingSupply: supply,
    supplyProvenance: supply === null ? 'unavailable' : 'provider_reported',
    volumeRolling24h: volume24h !== null && volume24h >= 0 ? volume24h : null,
    volumeHourly,
    volumeHourlySource: volumeHourly === null ? null : (raw.volumeHourlySource ?? null),
    providerChangePct1h: finiteOrNull(raw.changePct1h ?? null),
    providerChangePct24h: finiteOrNull(raw.changePct24h ?? null),
    providerChangePct7d: finiteOrNull(raw.changePct7d ?? null),
    ...liquidity,
    liquiditySource: raw.liquiditySource ?? null,
    rank,
    dateAdded,
    tags,
    qualityFlags: flags,
    completeness: present / CORE_FIELDS.length,
    freshnessSeconds,
    isStale,
    nullReasons,
  };
}

/** Normalize chain + contract for identity matching. EVM addresses are case-insensitive. */
export function normalizeContract(
  chain: string,
  address: string,
): { chain: string; contractAddress: string } {
  const c = chain.trim().toLowerCase();
  const a = address.trim();
  return { chain: c, contractAddress: /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a };
}

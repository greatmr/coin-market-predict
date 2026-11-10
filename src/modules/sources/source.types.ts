import type { VenuePair } from '../strategy/index.js';

/**
 * Source-independent adapter contract. Every adapter must:
 *  - label its access method explicitly;
 *  - report coverage honestly (`complete` only when every page the source offers was read);
 *  - return unavailable values as null, never estimates or substitutes.
 */

export const PROVIDER_ACCESS_METHODS = [
  'official_api',
  'website',
  'fixture',
  'public_dataset',
] as const;
export type ProviderAccessMethod = (typeof PROVIDER_ACCESS_METHODS)[number];

export interface ProviderInfo {
  id: string;
  name: string;
  accessMethod: ProviderAccessMethod;
  isLive: boolean;
  baseUrl: string | null;
  termsUrl: string | null;
  attribution: string | null;
}

export interface SourcePlatform {
  chain: string;
  contractAddress: string;
  decimals?: number | null;
}

export interface SourceAsset {
  providerAssetId: string;
  name: string;
  symbol: string;
  sourceUrl: string;
  platforms: SourcePlatform[];
  /** Provider categories used for classification (e.g. "stablecoins", "wrapped-tokens"). */
  categories?: string[];
}

export interface DiscoveryResult {
  assets: SourceAsset[];
  /** True only when the full listing was read. */
  complete: boolean;
  /** Total the source reports, if exposed. */
  sourceTotal: number | null;
  pagesFetched: number;
  requestsUsed: number;
  /** providerAssetIds the source tags as stablecoins / wrapped, when the source exposes categories. */
  categoryMembers: Record<string, string[]>;
  notes: string[];
}

/** One raw observation exactly as reported by the source (numbers already parsed). */
export interface RawObservation {
  providerAssetId: string;
  name: string;
  symbol: string;
  sourceUrl: string;
  /** Provider update time of the quote. */
  observedAt: Date | null;
  price: number | null;
  /** Provider-reported circulating market cap. */
  marketCap: number | null;
  fullyDilutedValuation: number | null;
  circulatingSupply: number | null;
  /** Rolling 24h volume in the quote currency. */
  volume24h: number | null;
  /** Actual traded volume within the hour; only from sources with hourly bars. */
  volumeHourly?: number | null;
  volumeHourlySource?: string | null;
  changePct1h?: number | null;
  changePct24h?: number | null;
  changePct7d?: number | null;
  bidAskSpreadPct?: number | null;
  depthPlus2PctUsd?: number | null;
  depthMinus2PctUsd?: number | null;
  liquiditySource?: string | null;
  /** Classification categories reported alongside the observation (e.g. mapped CMC tags). */
  categories?: string[];
  /** Provider rank (CMC `cmcRank`); null when the source gives none. */
  rank?: number | null;
  /** Provider first-listing date (CMC `dateAdded`). */
  dateAdded?: Date | null;
  /** Raw provider tags (CMC `tags`). */
  tags?: string[];
  slug?: string | null;
  platform?: { chain: string; address: string } | null;
}

export interface CollectResult {
  observations: RawObservation[];
  /** True when every listed asset's observation was requested. */
  complete: boolean;
  pagesFetched: number;
  requestsUsed: number;
  /** Universe size the source reports for this listing, if known. */
  universeSize: number | null;
  notes: string[];
  quoteCurrency: 'USD';
}

export interface CollectOptions {
  slot: Date;
  maxPages: number;
}

export interface MarketDataSource {
  readonly info: ProviderInfo;
  discover(): Promise<DiscoveryResult>;
  collect(opts: CollectOptions): Promise<CollectResult>;
}

export const MARKET_DATA_SOURCE = Symbol('MARKET_DATA_SOURCE');

// ---------------------------------------------------------------------------------------------
// Tier 1 inputs that the existing crawler collects in addition to the hourly listing
// (docs/tier1-input-mapping.md gaps G4–G7).
// ---------------------------------------------------------------------------------------------

/** One completed UTC day as published by the source; numbers keep their exact source text. */
export interface DailySourceRow {
  cmcId: number;
  dateUtc: string;
  volume: string | null;
  marketCap: string | null;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  /**
   * The source's documented time of the day's High / Low (CMC `timeHigh` / `timeLow`, minute
   * resolution). Used by the forward test to prove a signal-day High came after detection.
   */
  timeHigh?: Date | null;
  timeLow?: Date | null;
  /** Source-level problems (wrong currency, misaligned period, unparseable field). */
  invalidReasons: string[];
  periodStart: Date | null;
  periodEnd: Date | null;
  sourceCloseAt: Date | null;
  sourceFields: Record<string, unknown>;
}

export interface DailyFetch {
  rows: DailySourceRow[];
  /** Rows for the open (incomplete) day or later, which are never stored. */
  incompleteSkipped: number;
  /** Rows outside the requested date range (the website returns some). */
  outOfRange: number;
  source: string;
  params: Record<string, string>;
  responseSha256: string | null;
  retrievedAt: Date;
}

export interface VenueFetch {
  pairs: VenuePair[];
  /** Pair count the source reports for the request (null = unknown). */
  expectedCount: number | null;
  complete: boolean;
  requests: number;
  source: string;
  params: Record<string, string>;
  responseSha256: string[];
  retrievedAt: Date;
  notes: string[];
}

export interface Tier1Source {
  readonly providerId: string;
  /** Completed daily rows for one asset between two UTC dates (inclusive). */
  dailyHistory(
    asset: { cmcId: number; slug: string | null },
    from: string,
    to: string,
    now: Date,
  ): Promise<DailyFetch>;
  /** Every LBank Spot pair the feed publishes, with the CMC id of each base asset. */
  lbankSpotPairs(at: Date): Promise<VenueFetch>;
  /** One asset's CMC Markets spot pairs across exchanges. */
  assetMarkets(asset: { cmcId: number; slug: string | null }, at: Date): Promise<VenueFetch>;
}

export const TIER1_SOURCE = Symbol('TIER1_SOURCE');

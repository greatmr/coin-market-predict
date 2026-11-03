/**
 * Source-independent adapter contract. Every adapter must:
 *  - use only permitted, documented access methods;
 *  - report coverage honestly (`complete` only when every page the source offers was read);
 *  - return unavailable values as null, never estimates or substitutes.
 */

export interface ProviderInfo {
  id: string;
  name: string;
  accessMethod: "official_api" | "fixture" | "public_dataset";
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
  /** Classification categories reported alongside the observation (e.g. CMC tags). */
  categories?: string[];
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
  quoteCurrency: "USD";
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

export const MARKET_DATA_SOURCE = Symbol("MARKET_DATA_SOURCE");

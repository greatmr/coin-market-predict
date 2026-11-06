import { z } from 'zod';

import type { PoliteHttpClient } from '../http/polite-client.js';
import type {
  CollectOptions,
  CollectResult,
  DiscoveryResult,
  MarketDataSource,
  ProviderInfo,
  RawObservation,
  SourceAsset,
} from '../source.types.js';

/**
 * OPTIONAL live adapter: CoinGecko official API, free "Demo" plan (API key required).
 * Website scraping is prohibited by CoinGecko's terms; this uses only documented endpoints.
 * Terms caveats (see docs/source-feasibility.md): attribution required ("Powered by CoinGecko"),
 * the Demo plan is not licensed for commercial use, and long-term storage needs permission.
 */
export const COINGECKO_PROVIDER: ProviderInfo = {
  id: 'coingecko',
  name: 'CoinGecko API (Demo plan)',
  accessMethod: 'official_api',
  isLive: true,
  baseUrl: 'https://api.coingecko.com/api/v3',
  termsUrl: 'https://www.coingecko.com/en/api_terms',
  attribution: 'Powered by CoinGecko',
};

export const COINGECKO_PAGE_SIZE = 250;

const num = z.number().nullable().optional();

const marketItem = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  current_price: num,
  market_cap: num,
  fully_diluted_valuation: num,
  total_volume: num,
  circulating_supply: num,
  last_updated: z.string().nullable().optional(),
  price_change_percentage_1h_in_currency: num,
  price_change_percentage_24h_in_currency: num,
  price_change_percentage_7d_in_currency: num,
});

const listItem = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  platforms: z.record(z.string(), z.string().nullable()).optional(),
});

export function parseCoinGeckoMarkets(body: unknown): {
  observations: RawObservation[];
  skipped: number;
  rows: number;
} {
  const rows = z.array(z.unknown()).parse(body);
  let skipped = 0;
  const observations: RawObservation[] = [];
  for (const r of rows) {
    const p = marketItem.safeParse(r);
    if (!p.success) {
      skipped++;
      continue;
    }
    const d = p.data;
    observations.push({
      providerAssetId: d.id,
      name: d.name,
      symbol: d.symbol,
      sourceUrl: `https://www.coingecko.com/en/coins/${encodeURIComponent(d.id)}`,
      observedAt: d.last_updated ? new Date(d.last_updated) : null,
      price: d.current_price ?? null,
      marketCap: d.market_cap ?? null,
      fullyDilutedValuation: d.fully_diluted_valuation ?? null,
      circulatingSupply: d.circulating_supply ?? null,
      volume24h: d.total_volume ?? null,
      changePct1h: d.price_change_percentage_1h_in_currency ?? null,
      changePct24h: d.price_change_percentage_24h_in_currency ?? null,
      changePct7d: d.price_change_percentage_7d_in_currency ?? null,
    });
  }
  return { observations, skipped, rows: rows.length };
}

export function parseCoinGeckoList(body: unknown): SourceAsset[] {
  const rows = z.array(z.unknown()).parse(body);
  const out: SourceAsset[] = [];
  for (const r of rows) {
    const p = listItem.safeParse(r);
    if (!p.success) continue;
    out.push({
      providerAssetId: p.data.id,
      name: p.data.name,
      symbol: p.data.symbol,
      sourceUrl: `https://www.coingecko.com/en/coins/${encodeURIComponent(p.data.id)}`,
      platforms: Object.entries(p.data.platforms ?? {})
        .filter(([chain, addr]) => chain && addr)
        .map(([chain, addr]) => ({ chain, contractAddress: addr as string })),
    });
  }
  return out;
}

export class CoinGeckoSource implements MarketDataSource {
  readonly info = COINGECKO_PROVIDER;
  constructor(private readonly http: PoliteHttpClient) {}

  async discover(): Promise<DiscoveryResult> {
    const before = this.http.requestsMade;
    const assets = parseCoinGeckoList(
      await this.http.getJson(`${COINGECKO_PROVIDER.baseUrl}/coins/list?include_platform=true`),
    );
    const categoryMembers: Record<string, string[]> = {};
    const notes: string[] = [];
    // Category tagging, budgeted to two pages per category.
    for (const category of ['stablecoins', 'wrapped-tokens']) {
      for (let page = 1; page <= 2; page++) {
        const parsed = parseCoinGeckoMarkets(
          await this.http.getJson(
            `${COINGECKO_PROVIDER.baseUrl}/coins/markets?vs_currency=usd&category=${category}&per_page=${COINGECKO_PAGE_SIZE}&page=${page}`,
          ),
        );
        (categoryMembers[category] ??= []).push(
          ...parsed.observations.map((o) => o.providerAssetId),
        );
        if (parsed.rows < COINGECKO_PAGE_SIZE) break;
        if (page === 2)
          notes.push(
            `${category}: more than ${2 * COINGECKO_PAGE_SIZE} members; remainder tagged heuristically`,
          );
      }
    }
    return {
      assets,
      complete: true, // /coins/list returns the full active list in one response
      sourceTotal: assets.length,
      pagesFetched: 1,
      requestsUsed: this.http.requestsMade - before,
      categoryMembers,
      notes,
    };
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const observations: RawObservation[] = [];
    const notes: string[] = [];
    let pages = 0;
    let complete = false;
    const before = this.http.requestsMade;
    for (let page = 1; page <= opts.maxPages; page++) {
      const parsed = parseCoinGeckoMarkets(
        await this.http.getJson(
          `${COINGECKO_PROVIDER.baseUrl}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${COINGECKO_PAGE_SIZE}&page=${page}&price_change_percentage=1h,24h,7d`,
        ),
      );
      pages++;
      if (parsed.skipped) notes.push(`page ${page}: skipped ${parsed.skipped} malformed rows`);
      observations.push(...parsed.observations);
      if (parsed.rows < COINGECKO_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete)
      notes.push(
        `stopped after ${pages} pages (request budget); lower-ranked assets not collected this run`,
      );
    return {
      observations,
      complete,
      pagesFetched: pages,
      requestsUsed: this.http.requestsMade - before,
      universeSize: null,
      notes,
      quoteCurrency: 'USD',
    };
  }
}

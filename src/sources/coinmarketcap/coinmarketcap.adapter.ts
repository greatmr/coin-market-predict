import { z } from "zod";
import type { PoliteHttpClient } from "../http/polite-client.js";
import type {
  CollectOptions,
  CollectResult,
  DiscoveryResult,
  MarketDataSource,
  ProviderInfo,
  RawObservation,
  SourceAsset,
} from "../types.js";

/**
 * OPTIONAL live adapter: CoinMarketCap official API, free "Basic" plan (API key required).
 * Official API alternative to the website collector (explicit opt-in with a key).
 * Docs: https://coinmarketcap.com/api/documentation/v1/
 */
export const CMC_PROVIDER: ProviderInfo = {
  id: "coinmarketcap",
  name: "CoinMarketCap API (Basic plan)",
  accessMethod: "official_api",
  isLive: true,
  baseUrl: "https://pro-api.coinmarketcap.com",
  termsUrl: "https://coinmarketcap.com/api/pricing/",
  attribution: "Data: CoinMarketCap",
};

export const CMC_PAGE_SIZE = 200; // 1 credit per 200 listings on v1 listings/latest
const MAP_PAGE_SIZE = 5000;

const num = z.number().nullable().optional();

const listingSchema = z.object({
  id: z.number(),
  name: z.string(),
  symbol: z.string(),
  slug: z.string(),
  tags: z.array(z.string()).nullable().optional(),
  cmc_rank: z.number().int().nullable().optional(),
  date_added: z.string().nullable().optional(),
  circulating_supply: num,
  total_supply: num,
  max_supply: num,
  last_updated: z.string().nullable().optional(),
  platform: z
    .object({ slug: z.string().optional(), name: z.string().optional(), token_address: z.string().optional() })
    .nullable()
    .optional(),
  quote: z.object({
    USD: z.object({
      price: num,
      volume_24h: num,
      percent_change_1h: num,
      percent_change_24h: num,
      percent_change_7d: num,
      market_cap: num,
      fully_diluted_market_cap: num,
      last_updated: z.string().nullable().optional(),
    }),
  }),
});

const statusSchema = z.object({
  error_code: z.union([z.number(), z.string()]).transform(Number),
  error_message: z.string().nullable().optional(),
  credit_count: z.number().optional(),
  total_count: z.number().optional(),
});

const listingsResponse = z.object({ status: statusSchema, data: z.array(z.unknown()) });

const mapItem = z.object({
  id: z.number(),
  name: z.string(),
  symbol: z.string(),
  slug: z.string(),
  is_active: z.number().optional(),
  platform: z.object({ slug: z.string().optional(), token_address: z.string().optional() }).nullable().optional(),
});

export function parseCmcListings(body: unknown): { observations: RawObservation[]; skipped: number; totalCount: number | null } {
  const res = listingsResponse.parse(body);
  if (res.status.error_code !== 0) throw new Error(`CMC error ${res.status.error_code}: ${res.status.error_message ?? ""}`);
  let skipped = 0;
  const observations: RawObservation[] = [];
  for (const item of res.data) {
    const p = listingSchema.safeParse(item);
    if (!p.success) {
      skipped++;
      continue;
    }
    const d = p.data;
    const q = d.quote.USD;
    const observed = q.last_updated ?? d.last_updated ?? null;
    observations.push({
      providerAssetId: String(d.id),
      name: d.name,
      symbol: d.symbol,
      sourceUrl: `https://coinmarketcap.com/currencies/${encodeURIComponent(d.slug)}/`,
      observedAt: observed ? new Date(observed) : null,
      price: q.price ?? null,
      marketCap: q.market_cap ?? null,
      fullyDilutedValuation: q.fully_diluted_market_cap ?? null,
      circulatingSupply: d.circulating_supply ?? null,
      volume24h: q.volume_24h ?? null,
      changePct1h: q.percent_change_1h ?? null,
      changePct24h: q.percent_change_24h ?? null,
      changePct7d: q.percent_change_7d ?? null,
      categories: cmcCategories(d.tags),
      rank: d.cmc_rank && d.cmc_rank > 0 ? d.cmc_rank : null,
      dateAdded: d.date_added && Number.isFinite(Date.parse(d.date_added)) ? new Date(d.date_added) : null,
      tags: d.tags ?? [],
      slug: d.slug,
      platform: d.platform?.slug && d.platform.token_address ? { chain: d.platform.slug, address: d.platform.token_address } : null,
    });
  }
  return { observations, skipped, totalCount: res.status.total_count ?? null };
}

/** CMC tags used for classification. */
/** Tags of tokens that represent an off-chain asset (equities, ETFs, commodities, treasuries). */
const TOKENIZED_TAGS = new Set(["tokenized-stock", "tokenized-etfs", "tokenized-commodities", "tokenized-gold", "tokenized-silver", "tokenized-treasury-bonds", "tokenized-treasury-bills", "tokenized-real-estate"]);

/**
 * Map CoinMarketCap tags to classification categories. Only unambiguous tags are used:
 * "stablecoin-protocol" marks governance tokens and "liquid-staking-derivatives" also tags
 * protocol tokens such as LDO or RPL, so neither excludes a coin on its own.
 */
export function cmcCategories(tags: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    if (t === "stablecoin" || t.endsWith("-stablecoin")) out.push("stablecoins");
    if (t.includes("wrapped")) out.push("wrapped-tokens");
    if (TOKENIZED_TAGS.has(t)) out.push("tokenized-assets");
  }
  return [...new Set(out)];
}

export class CoinMarketCapSource implements MarketDataSource {
  readonly info = CMC_PROVIDER;

  constructor(private readonly http: PoliteHttpClient) {}

  async discover(): Promise<DiscoveryResult> {
    const assets: SourceAsset[] = [];
    let start = 1;
    let pages = 0;
    let complete = false;
    const before = this.http.requestsMade;
    for (; pages < 20; ) {
      const body = await this.http.getJson<unknown>(
        `${CMC_PROVIDER.baseUrl}/v1/cryptocurrency/map?listing_status=active&start=${start}&limit=${MAP_PAGE_SIZE}&aux=platform`,
      );
      pages++;
      const res = listingsResponse.parse(body);
      if (res.status.error_code !== 0) throw new Error(`CMC error ${res.status.error_code}`);
      for (const item of res.data) {
        const m = mapItem.safeParse(item);
        if (!m.success) continue;
        const plat = m.data.platform;
        assets.push({
          providerAssetId: String(m.data.id),
          name: m.data.name,
          symbol: m.data.symbol,
          sourceUrl: `https://coinmarketcap.com/currencies/${encodeURIComponent(m.data.slug)}/`,
          platforms: plat?.slug && plat.token_address ? [{ chain: plat.slug, contractAddress: plat.token_address }] : [],
        });
      }
      if (res.data.length < MAP_PAGE_SIZE) {
        complete = true;
        break;
      }
      start += MAP_PAGE_SIZE;
    }
    return {
      assets,
      complete,
      sourceTotal: complete ? assets.length : null,
      pagesFetched: pages,
      requestsUsed: this.http.requestsMade - before,
      categoryMembers: {},
      notes: [
        "CMC map lists the primary contract only; additional chain deployments are not included",
        "stablecoin/wrapped tags are applied from listings during collection",
      ],
    };
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const observations: RawObservation[] = [];
    const notes: string[] = [];
    let pages = 0;
    let complete = false;
    let universe: number | null = null;
    const before = this.http.requestsMade;
    for (let start = 1; pages < opts.maxPages; start += CMC_PAGE_SIZE) {
      const body = await this.http.getJson<unknown>(
        `${CMC_PROVIDER.baseUrl}/v1/cryptocurrency/listings/latest?start=${start}&limit=${CMC_PAGE_SIZE}&convert=USD&sort=market_cap`,
      );
      pages++;
      const parsed = parseCmcListings(body);
      universe = parsed.totalCount ?? universe;
      if (parsed.skipped) notes.push(`page ${pages}: skipped ${parsed.skipped} malformed rows`);
      observations.push(...parsed.observations);
      if (parsed.observations.length + parsed.skipped < CMC_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete) notes.push(`stopped after ${pages} pages (request budget); lower-ranked assets not collected this run`);
    return {
      observations,
      complete,
      pagesFetched: pages,
      requestsUsed: this.http.requestsMade - before,
      universeSize: universe,
      notes,
      quoteCurrency: "USD",
    };
  }
}

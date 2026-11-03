import type { CollectOptions, CollectResult, DiscoveryResult, MarketDataSource, ProviderInfo } from "../types.js";
import { FixtureMarket } from "./fixture-market.js";

export const FIXTURE_PROVIDER: ProviderInfo = {
  id: "fixture",
  name: "Synthetic fixture market (NOT real data)",
  accessMethod: "fixture",
  isLive: false,
  baseUrl: null,
  termsUrl: null,
  attribution: "Synthetic fixture data generated locally — not market data",
};

export class FixtureSource implements MarketDataSource {
  readonly info = FIXTURE_PROVIDER;

  constructor(private readonly anchor: () => Promise<Date>) {}

  async market(): Promise<FixtureMarket> {
    return new FixtureMarket(await this.anchor());
  }

  async discover(): Promise<DiscoveryResult> {
    const m = await this.market();
    const assets = m.listing();
    const categoryMembers: Record<string, string[]> = {};
    for (const a of assets) for (const c of a.categories ?? []) (categoryMembers[c] ??= []).push(a.providerAssetId);
    return {
      assets,
      complete: true,
      sourceTotal: assets.length,
      pagesFetched: 1,
      requestsUsed: 0,
      categoryMembers,
      notes: ["fixture listing is complete by construction"],
    };
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const m = await this.market();
    const observations = m.observationsFor(opts.slot);
    return {
      observations,
      complete: true,
      pagesFetched: 1,
      requestsUsed: 0,
      universeSize: FixtureMarket.specs().length,
      notes: observations.length === 0 ? ["fixture market has no data before its history window"] : [],
      quoteCurrency: "USD",
    };
  }
}

import { sha256 } from '../../../common/utils/decimal.js';

import type {
  CollectOptions,
  CollectResult,
  DailyFetch,
  DiscoveryResult,
  MarketDataSource,
  ProviderInfo,
  Tier1Source,
  VenueFetch,
} from '../source.types.js';

import { FIXTURE_LISTED, FixtureCmcMarket } from './fixture-cmc.js';

export const FIXTURE_PROVIDER: ProviderInfo = {
  id: 'fixture',
  name: 'Synthetic fixture market (NOT real data)',
  accessMethod: 'fixture',
  isLive: false,
  baseUrl: null,
  termsUrl: null,
  attribution: 'Synthetic fixture data generated locally — not market data',
};

type MarketFactory = () => Promise<FixtureCmcMarket>;

export class FixtureSource implements MarketDataSource {
  readonly info = FIXTURE_PROVIDER;

  constructor(private readonly market: MarketFactory) {}

  async discover(): Promise<DiscoveryResult> {
    const m = await this.market();
    const assets = m.observations(new Date()).map((o) => ({
      providerAssetId: o.providerAssetId,
      name: o.name,
      symbol: o.symbol,
      sourceUrl: o.sourceUrl,
      platforms: [],
      categories: o.categories,
    }));
    return {
      assets,
      complete: true,
      sourceTotal: assets.length,
      pagesFetched: 1,
      requestsUsed: 0,
      categoryMembers: {},
      notes: ['fixture listing is complete by construction'],
    };
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const observations = (await this.market()).observations(opts.slot);
    return {
      observations,
      complete: true,
      pagesFetched: 1,
      requestsUsed: 0,
      universeSize: observations.length,
      notes: [`SYNTHETIC fixture listing (ranks 1–${FIXTURE_LISTED} plus unranked coins)`],
      quoteCurrency: 'USD',
    };
  }
}

/** Synthetic Tier 1 inputs; its LBank feed includes trading status so VERIFIED can be shown offline. */
export class FixtureTier1Source implements Tier1Source {
  readonly providerId = FIXTURE_PROVIDER.id;

  constructor(private readonly market: MarketFactory) {}

  async dailyHistory(
    asset: { cmcId: number },
    from: string,
    to: string,
    now: Date,
  ): Promise<DailyFetch> {
    const today = now.toISOString().slice(0, 10);
    const all = (await this.market()).dailyRows(asset.cmcId, from, to);
    const rows = all.filter((r) => r.dateUtc < today);
    return {
      rows,
      incompleteSkipped: all.length - rows.length,
      outOfRange: 0,
      source: 'fixture:daily',
      params: { cmcId: String(asset.cmcId), from, to },
      responseSha256: sha256(JSON.stringify(rows)),
      retrievedAt: now,
    };
  }

  async lbankSpotPairs(at: Date): Promise<VenueFetch> {
    const pairs = (await this.market()).lbankPairs(at);
    return {
      pairs,
      expectedCount: pairs.length,
      complete: true,
      requests: 0,
      source: 'fixture:lbank_spot_pairs',
      params: {},
      responseSha256: [sha256(JSON.stringify(pairs))],
      retrievedAt: at,
      notes: ['SYNTHETIC LBank pairs (with explicit trading status)'],
    };
  }

  async assetMarkets(asset: { cmcId: number }, at: Date): Promise<VenueFetch> {
    const m = (await this.market()).assetMarkets(asset.cmcId, at);
    return {
      pairs: m.pairs,
      expectedCount: m.expected,
      complete: true,
      requests: 0,
      source: 'fixture:asset_markets',
      params: { cmcId: String(asset.cmcId) },
      responseSha256: [sha256(JSON.stringify(m.pairs))],
      retrievedAt: at,
      notes: [],
    };
  }
}

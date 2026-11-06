import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { isoDate } from '../../common/utils/dates.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { AppStateModule } from '../app-state/app-state.module.js';
import { AppStateService } from '../app-state/app-state.service.js';

import { COINGECKO_PROVIDER, CoinGeckoSource } from './coingecko/coingecko.adapter.js';
import { CMC_WEB_PROVIDER, CmcWebClient, webResponseStatus } from './coinmarketcap-web/client.js';
import {
  CmcWebTier1Source,
  CoinMarketCapWebSource,
} from './coinmarketcap-web/coinmarketcap-web.adapter.js';
import { CMC_PROVIDER, CoinMarketCapSource } from './coinmarketcap/coinmarketcap.adapter.js';
import { Provider } from './entities/provider.entity.js';
import { SourceHealth } from './entities/source-health.entity.js';
import { FixtureCmcMarket } from './fixture/fixture-cmc.js';
import { FixtureSource, FixtureTier1Source } from './fixture/fixture.adapter.js';
import { PoliteHttpClient } from './http/polite-client.js';
import type { SourceHealthStore } from './http/source-health.js';
import { ProviderService } from './provider.service.js';
import { SourceHealthService } from './source-health.service.js';
import {
  MARKET_DATA_SOURCE,
  type MarketDataSource,
  type ProviderInfo,
  TIER1_SOURCE,
  type Tier1Source,
} from './source.types.js';

export const FIXTURE_ANCHOR_KEY = 'fixture.tier1AnchorDate';

/** The synthetic market is anchored once (first use) so its designed cases and history stay consistent. */
export async function fixtureAnchorDate(
  state: AppStateService,
  now: () => Date = () => new Date(),
): Promise<string> {
  const existing = await state.get(FIXTURE_ANCHOR_KEY);
  if (existing !== undefined) return String(existing);
  await state.setIfAbsent(FIXTURE_ANCHOR_KEY, isoDate(now()));
  return String(await state.get(FIXTURE_ANCHOR_KEY));
}

function fixtureMarket(state: AppStateService) {
  let cached: { date: string; market: FixtureCmcMarket } | null = null;
  return async () => {
    const date = await fixtureAnchorDate(state);
    if (cached?.date !== date) cached = { date, market: new FixtureCmcMarket(date) };
    return cached.market;
  };
}

/** Persisted circuit state; the provider row is created first so the foreign key always holds. */
function healthStore(
  health: SourceHealthService,
  providers: ProviderService,
  info: ProviderInfo,
): SourceHealthStore {
  return {
    load: (id) => health.load(id),
    save: async (id, state) => {
      await providers.ensureExists(info);
      await health.save(id, state);
    },
  };
}

/** One shared, polite HTTP queue for every CMC website route (listing, history, market pairs). */
export function createWebClient(
  cfg: AppConfig,
  health: SourceHealthService,
  providers: ProviderService,
): CmcWebClient {
  return new CmcWebClient(
    new PoliteHttpClient({
      providerId: CMC_WEB_PROVIDER.id,
      requestsPerMinute: cfg.CMC_WEB_REQUESTS_PER_MINUTE,
      monthlyBudget: cfg.CMC_WEB_MONTHLY_REQUEST_BUDGET,
      maxAttempts: cfg.CMC_WEB_MAX_RETRIES + 1,
      headers: {
        accept: 'application/json, text/html;q=0.9, */*;q=0.8',
        origin: 'https://coinmarketcap.com',
        referer: 'https://coinmarketcap.com/',
        platform: 'web',
      },
      responseStatus: webResponseStatus,
      store: healthStore(health, providers, CMC_WEB_PROVIDER),
    }),
    cfg.CMC_WEB_CACHE_SECONDS * 1000,
  );
}

export function createSource(
  cfg: AppConfig,
  state: AppStateService,
  health: SourceHealthService,
  providers: ProviderService,
  web?: CmcWebClient,
): MarketDataSource {
  const client = (info: ProviderInfo, headers: Record<string, string>) =>
    new PoliteHttpClient({
      providerId: info.id,
      requestsPerMinute: cfg.SOURCE_REQUESTS_PER_MINUTE,
      monthlyBudget: cfg.SOURCE_MONTHLY_REQUEST_BUDGET,
      headers,
      store: healthStore(health, providers, info),
    });
  switch (cfg.DATA_SOURCE) {
    case 'coinmarketcap_web':
      if (!web) throw new Error('CMC website client is not available');
      return new CoinMarketCapWebSource(
        web,
        cfg.SOURCE_MAX_MARKET_PAGES_PER_RUN,
        cfg.CMC_WEB_LISTING_PAGE_SIZE,
      );
    case 'coinmarketcap':
      return new CoinMarketCapSource(
        client(CMC_PROVIDER, { 'X-CMC_PRO_API_KEY': cfg.CMC_API_KEY! }),
      );
    case 'coingecko':
      return new CoinGeckoSource(
        client(COINGECKO_PROVIDER, { 'x-cg-demo-api-key': cfg.COINGECKO_API_KEY! }),
      );
    default:
      return new FixtureSource(fixtureMarket(state));
  }
}

/**
 * Tier 1 inputs beyond the listing. Only the CMC website collector (and the synthetic fixture)
 * can supply daily rows, LBank pairs and CMC Markets venue rows; other sources get null and the
 * dependent outputs are N/A / PENDING with a reason.
 */
export function createTier1Source(
  cfg: AppConfig,
  state: AppStateService,
  web?: CmcWebClient,
): Tier1Source | null {
  if (cfg.DATA_SOURCE === 'coinmarketcap_web') return web ? new CmcWebTier1Source(web) : null;
  if (cfg.DATA_SOURCE === 'fixture') return new FixtureTier1Source(fixtureMarket(state));
  return null;
}

/**
 * Market-data adapters (`MarketDataSource` for the hourly listing, `Tier1Source` for daily rows,
 * LBank pairs and CMC Markets venues), the polite HTTP client, and the provider / source-health
 * records. The only way data enters the system.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Provider, SourceHealth]), AppStateModule],
  providers: [
    ProviderService,
    SourceHealthService,
    {
      provide: CmcWebClient,
      inject: [APP_CONFIG, SourceHealthService, ProviderService],
      useFactory: createWebClient,
    },
    {
      provide: MARKET_DATA_SOURCE,
      inject: [APP_CONFIG, AppStateService, SourceHealthService, ProviderService, CmcWebClient],
      useFactory: createSource,
    },
    {
      provide: TIER1_SOURCE,
      inject: [APP_CONFIG, AppStateService, CmcWebClient],
      useFactory: createTier1Source,
    },
  ],
  exports: [ProviderService, SourceHealthService, CmcWebClient, MARKET_DATA_SOURCE, TIER1_SOURCE],
})
export class SourcesModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { AppStateModule } from '../app-state/app-state.module.js';
import { AppStateService } from '../app-state/app-state.service.js';
import { LeaseService } from '../pipeline/lease.service.js';
import { FixtureCmcMarket } from '../sources/fixture/fixture-cmc.js';
import { PoliteHttpClient } from '../sources/http/polite-client.js';
import { ProviderService } from '../sources/provider.service.js';
import { SourceHealthService } from '../sources/source-health.service.js';
import { SourcesModule, fixtureAnchorDate } from '../sources/sources.module.js';
import { StarEventsModule } from '../star-events/star-events.module.js';
import { StrategyModule } from '../strategy/index.js';

import { CandleStoreService } from './candle-store.service.js';
import { CandleArchive } from './entities/candle-archive.entity.js';
import { MarketListFetch } from './entities/market-list-fetch.entity.js';
import { ObsEvent } from './entities/obs-event.entity.js';
import { ObsIntakeRun } from './entities/obs-intake-run.entity.js';
import { ObsRun } from './entities/obs-run.entity.js';
import { ObservationResult } from './entities/observation-result.entity.js';
import { Observation } from './entities/observation.entity.js';
import { ObsRulesChange } from './entities/rules-change.entity.js';
import { SpotCandle } from './entities/spot-candle.entity.js';
import { SpotPair } from './entities/spot-pair.entity.js';
import { SpotTrade } from './entities/spot-trade.entity.js';
import { TradeMinute } from './entities/trade-minute.entity.js';
import { lbankResponseStatus } from './kline.js';
import {
  FixtureLbankSource,
  LBANK_MARKET_SOURCE,
  LBANK_SPOT_PROVIDER_INFO,
  LbankApiSource,
  type LbankMarketSource,
} from './lbank-market.source.js';
import { ListingEvidenceService } from './listing-evidence.service.js';
import { ObservationIntakeService } from './observation-intake.service.js';
import { ObservationReadService } from './observation-read.service.js';
import { ObservationUpdateService } from './observation-update.service.js';
import { ObservationService } from './observation.service.js';
import { TradeStoreService } from './trade-store.service.js';

/**
 * The market source: LBank's official public API for a live data source, the synthetic fixture
 * otherwise (or as LBANK_OBSERVATION_SOURCE says). The API client has its own circuit breaker and
 * request budget (provider `lbank_spot`), never the CMC website's.
 */
export function createLbankSource(
  cfg: AppConfig,
  state: AppStateService,
  health: SourceHealthService,
  providers: ProviderService,
): LbankMarketSource {
  const api =
    cfg.LBANK_OBSERVATION_SOURCE === 'api' ||
    (cfg.LBANK_OBSERVATION_SOURCE === 'auto' && cfg.DATA_SOURCE !== 'fixture');
  if (!api) {
    let cached: { date: string; market: FixtureCmcMarket } | null = null;
    // The same synthetic market (and anchor date) as the CMC fixture source.
    return new FixtureLbankSource(async () => {
      const date = await fixtureAnchorDate(state);
      if (cached?.date !== date) cached = { date, market: new FixtureCmcMarket(date) };
      return cached.market;
    });
  }
  return new LbankApiSource(
    new PoliteHttpClient({
      providerId: LBANK_SPOT_PROVIDER_INFO.id,
      requestsPerMinute: cfg.LBANK_REQUESTS_PER_MINUTE,
      monthlyBudget: cfg.LBANK_MONTHLY_REQUEST_BUDGET,
      maxAttempts: 3,
      userAgent: 'CoinsPredicts/0.1 (research; LBank public market data, read-only)',
      responseStatus: (res, body) => lbankResponseStatus(res.status, body),
      store: {
        load: (id) => health.load(id),
        save: async (id, s) => {
          await providers.ensureExists(LBANK_SPOT_PROVIDER_INFO);
          await health.save(id, s);
        },
      },
    }),
    cfg.LBANK_API_BASE_URL.replace(/\/+$/, ''),
    cfg.LBANK_FUTURES_API_BASE_URL.replace(/\/+$/, ''),
  );
}

/**
 * LBank Spot Price Observation (docs/lbank-spot-observation.md, ADR-0009): its own tables, intake,
 * candle collection, job, reads and export. It reads the published Review Queue through the shared
 * star-event layer and never changes a Tier 1 rule, a scan result or a legacy forward-test row.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ObsIntakeRun,
      ObsEvent,
      SpotPair,
      SpotCandle,
      MarketListFetch,
      Observation,
      ObservationResult,
      ObsRun,
      SpotTrade,
      TradeMinute,
      CandleArchive,
      ObsRulesChange,
    ]),
    AppStateModule,
    SourcesModule,
    StrategyModule,
    StarEventsModule,
  ],
  providers: [
    {
      provide: LBANK_MARKET_SOURCE,
      useFactory: createLbankSource,
      inject: [APP_CONFIG, AppStateService, SourceHealthService, ProviderService],
    },
    LeaseService,
    CandleStoreService,
    TradeStoreService,
    ListingEvidenceService,
    ObservationIntakeService,
    ObservationUpdateService,
    ObservationReadService,
    ObservationService,
  ],
  exports: [
    ObservationIntakeService,
    ObservationReadService,
    ObservationService,
    LBANK_MARKET_SOURCE,
  ],
})
export class LbankObservationModule {}

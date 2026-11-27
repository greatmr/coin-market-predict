import { AgentAnalysis } from '../modules/agent/entities/agent-analysis.entity.js';
import { ChatConversation } from '../modules/agent/entities/chat-conversation.entity.js';
import { ChatMessage } from '../modules/agent/entities/chat-message.entity.js';
import { AppState } from '../modules/app-state/entities/app-state.entity.js';
import { AppUser } from '../modules/auth/entities/app-user.entity.js';
import { UserSession } from '../modules/auth/entities/user-session.entity.js';
import { DailyFetchState } from '../modules/daily-metrics/entities/daily-fetch-state.entity.js';
import { DailyMetricRevision } from '../modules/daily-metrics/entities/daily-metric-revision.entity.js';
import { DailyMetric } from '../modules/daily-metrics/entities/daily-metric.entity.js';
import { ForwardDay0Capture } from '../modules/forward-test/entities/forward-day0-capture.entity.js';
import { ForwardEvent } from '../modules/forward-test/entities/forward-event.entity.js';
import { ForwardHigh } from '../modules/forward-test/entities/forward-high.entity.js';
import { ForwardLegacyClosure } from '../modules/forward-test/entities/forward-legacy-closure.entity.js';
import { ForwardOutcome } from '../modules/forward-test/entities/forward-outcome.entity.js';
import { ForwardTestWatchlist } from '../modules/forward-test/entities/forward-test-watchlist.entity.js';
import { ForwardTriggerRejection } from '../modules/forward-test/entities/forward-trigger-rejection.entity.js';
import { ForwardTriggerRun } from '../modules/forward-test/entities/forward-trigger-run.entity.js';
import { ForwardUpdateRun } from '../modules/forward-test/entities/forward-update-run.entity.js';
import { AssetContract } from '../modules/ingestion/entities/asset-contract.entity.js';
import { AssetIdentity } from '../modules/ingestion/entities/asset-identity.entity.js';
import { Asset } from '../modules/ingestion/entities/asset.entity.js';
import { CmcAssetChange } from '../modules/ingestion/entities/cmc-asset-change.entity.js';
import { CmcAsset } from '../modules/ingestion/entities/cmc-asset.entity.js';
import { CrawlBatch } from '../modules/ingestion/entities/crawl-batch.entity.js';
import { DiscoveryRun } from '../modules/ingestion/entities/discovery-run.entity.js';
import { MarketSnapshot } from '../modules/ingestion/entities/market-snapshot.entity.js';
import { CandleArchive } from '../modules/lbank-observation/entities/candle-archive.entity.js';
import { FuturesBook } from '../modules/lbank-observation/entities/futures-book.entity.js';
import { FuturesObservation } from '../modules/lbank-observation/entities/futures-observation.entity.js';
import { FuturesPoll } from '../modules/lbank-observation/entities/futures-poll.entity.js';
import { FuturesReference } from '../modules/lbank-observation/entities/futures-reference.entity.js';
import { FuturesSample } from '../modules/lbank-observation/entities/futures-sample.entity.js';
import { MarketListFetch } from '../modules/lbank-observation/entities/market-list-fetch.entity.js';
import { ObsEvent } from '../modules/lbank-observation/entities/obs-event.entity.js';
import { ObsIntakeRun } from '../modules/lbank-observation/entities/obs-intake-run.entity.js';
import { ObsRun } from '../modules/lbank-observation/entities/obs-run.entity.js';
import { ObservationResult } from '../modules/lbank-observation/entities/observation-result.entity.js';
import { Observation } from '../modules/lbank-observation/entities/observation.entity.js';
import { ObsRulesChange } from '../modules/lbank-observation/entities/rules-change.entity.js';
import { SpotCandle } from '../modules/lbank-observation/entities/spot-candle.entity.js';
import { SpotPair } from '../modules/lbank-observation/entities/spot-pair.entity.js';
import { SpotTrade } from '../modules/lbank-observation/entities/spot-trade.entity.js';
import { TradeMinute } from '../modules/lbank-observation/entities/trade-minute.entity.js';
import { JobLease } from '../modules/pipeline/entities/job-lease.entity.js';
import { PipelineRun } from '../modules/pipeline/entities/pipeline-run.entity.js';
import { PipelineStage } from '../modules/pipeline/entities/pipeline-stage.entity.js';
import { Review } from '../modules/reviews/entities/review.entity.js';
import { ScanResult } from '../modules/scan/entities/scan-result.entity.js';
import { ScanRun } from '../modules/scan/entities/scan-run.entity.js';
import { Provider } from '../modules/sources/entities/provider.entity.js';
import { SourceHealth } from '../modules/sources/entities/source-health.entity.js';
import { SignalCutover } from '../modules/star-events/entities/signal-cutover.entity.js';
import { TelegramDelivery } from '../modules/telegram/entities/telegram-delivery.entity.js';
import { VenueCrawl } from '../modules/venues/entities/venue-crawl.entity.js';
import { VenueDecision } from '../modules/venues/entities/venue-decision.entity.js';
import { VenueMappingTask } from '../modules/venues/entities/venue-mapping-task.entity.js';
import { VenuePairEvent } from '../modules/venues/entities/venue-pair-event.entity.js';

/**
 * Every entity, listed explicitly (no glob): the application, the TypeORM CLI data source and the
 * tests build the same metadata, in TypeScript and in compiled ESM alike. A new entity is added
 * here and to a migration in the same change.
 */
export const ENTITIES = [
  // sources & platform
  Provider,
  SourceHealth,
  AppState,
  JobLease,
  PipelineRun,
  PipelineStage,
  TelegramDelivery,
  // dashboard users
  AppUser,
  UserSession,
  // market data (ingestion)
  Asset,
  AssetIdentity,
  AssetContract,
  DiscoveryRun,
  CrawlBatch,
  MarketSnapshot,
  CmcAsset,
  CmcAssetChange,
  // Tier 1 inputs
  DailyMetricRevision,
  DailyMetric,
  DailyFetchState,
  VenueCrawl,
  VenuePairEvent,
  VenueDecision,
  VenueMappingTask,
  // Tier 1 results and human records
  ScanRun,
  ScanResult,
  Review,
  // Star Event Forward Test (docs/forward-test.md)
  ForwardTestWatchlist,
  ForwardTriggerRun,
  ForwardTriggerRejection,
  ForwardEvent,
  ForwardUpdateRun,
  ForwardDay0Capture,
  ForwardHigh,
  ForwardOutcome,
  ForwardLegacyClosure,
  // Cutover between the trackers and the LBank Spot Price Observation (ADR-0009)
  SignalCutover,
  ObsIntakeRun,
  ObsEvent,
  SpotPair,
  FuturesObservation,
  FuturesPoll,
  FuturesSample,
  FuturesReference,
  FuturesBook,
  SpotCandle,
  MarketListFetch,
  Observation,
  ObservationResult,
  ObsRun,
  SpotTrade,
  TradeMinute,
  CandleArchive,
  ObsRulesChange,
  // Claude coin agent (docs/adr/0005-coin-agent.md)
  AgentAnalysis,
  // Claude chat (docs/adr/0012-owner-chat.md)
  ChatConversation,
  ChatMessage,
];

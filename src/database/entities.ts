import { AgentAnalysis } from '../modules/agent/entities/agent-analysis.entity.js';
import { AppState } from '../modules/app-state/entities/app-state.entity.js';
import { AppUser } from '../modules/auth/entities/app-user.entity.js';
import { UserSession } from '../modules/auth/entities/user-session.entity.js';
import { DailyFetchState } from '../modules/daily-metrics/entities/daily-fetch-state.entity.js';
import { DailyMetricRevision } from '../modules/daily-metrics/entities/daily-metric-revision.entity.js';
import { DailyMetric } from '../modules/daily-metrics/entities/daily-metric.entity.js';
import { ForwardEvent } from '../modules/forward-test/entities/forward-event.entity.js';
import { ForwardHigh } from '../modules/forward-test/entities/forward-high.entity.js';
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
import { JobLease } from '../modules/pipeline/entities/job-lease.entity.js';
import { PipelineRun } from '../modules/pipeline/entities/pipeline-run.entity.js';
import { PipelineStage } from '../modules/pipeline/entities/pipeline-stage.entity.js';
import { Review } from '../modules/reviews/entities/review.entity.js';
import { ScanResult } from '../modules/scan/entities/scan-result.entity.js';
import { ScanRun } from '../modules/scan/entities/scan-run.entity.js';
import { Provider } from '../modules/sources/entities/provider.entity.js';
import { SourceHealth } from '../modules/sources/entities/source-health.entity.js';
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
  ForwardHigh,
  ForwardOutcome,
  // Claude coin agent (docs/adr/0005-coin-agent.md)
  AgentAnalysis,
];

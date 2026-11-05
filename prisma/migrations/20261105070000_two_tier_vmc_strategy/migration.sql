-- Two-Tier VMC strategy (docs/strategy-two-tier-vmc.md, docs/implementation-plan.md).
-- Retires the surge screen, agents, paper trading and the six-month VMC module (tables were
-- emptied first by scripts/db/2026-11-05-clear-coin-data.sql after a verified backup) and adds
-- the Tier 1 inputs/results and append-only human review tables.

-- DropForeignKey
ALTER TABLE "AgentExecution" DROP CONSTRAINT "AgentExecution_runId_fkey";

-- DropForeignKey
ALTER TABLE "FeatureValue" DROP CONSTRAINT "FeatureValue_assetId_fkey";

-- DropForeignKey
ALTER TABLE "PaperPosition" DROP CONSTRAINT "PaperPosition_signalId_fkey";

-- DropForeignKey
ALTER TABLE "ScreeningResult" DROP CONSTRAINT "ScreeningResult_assetId_fkey";

-- DropForeignKey
ALTER TABLE "ScreeningResult" DROP CONSTRAINT "ScreeningResult_runId_fkey";

-- DropForeignKey
ALTER TABLE "Signal" DROP CONSTRAINT "Signal_assetId_fkey";

-- DropForeignKey
ALTER TABLE "Signal" DROP CONSTRAINT "Signal_runId_fkey";

-- DropForeignKey
ALTER TABLE "SignalOutcome" DROP CONSTRAINT "SignalOutcome_signalId_fkey";

-- DropForeignKey
ALTER TABLE "VmcAssetMetadataChange" DROP CONSTRAINT "VmcAssetMetadataChange_cmcId_fkey";

-- DropForeignKey
ALTER TABLE "VmcAssetResult" DROP CONSTRAINT "VmcAssetResult_runId_fkey";

-- DropForeignKey
ALTER TABLE "VmcBaselineMember" DROP CONSTRAINT "VmcBaselineMember_baselineId_fkey";

-- DropForeignKey
ALTER TABLE "VmcRawResponse" DROP CONSTRAINT "VmcRawResponse_runId_fkey";

-- AlterTable
ALTER TABLE "MarketSnapshot" ADD COLUMN     "dateAdded" TIMESTAMPTZ(3),
ADD COLUMN     "rank" INTEGER,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "PipelineRun" DROP COLUMN "modelCostUsd";

-- DropTable
DROP TABLE "AgentExecution";

-- DropTable
DROP TABLE "BacktestReport";

-- DropTable
DROP TABLE "FeatureSetVersion";

-- DropTable
DROP TABLE "FeatureValue";

-- DropTable
DROP TABLE "PaperPosition";

-- DropTable
DROP TABLE "ScreeningResult";

-- DropTable
DROP TABLE "Signal";

-- DropTable
DROP TABLE "SignalOutcome";

-- DropTable
DROP TABLE "StrategyVersion";

-- DropTable
DROP TABLE "VmcAsset";

-- DropTable
DROP TABLE "VmcAssetMetadataChange";

-- DropTable
DROP TABLE "VmcAssetResult";

-- DropTable
DROP TABLE "VmcBaseline";

-- DropTable
DROP TABLE "VmcBaselineMember";

-- DropTable
DROP TABLE "VmcDailyCurrent";

-- DropTable
DROP TABLE "VmcDailyObservation";

-- DropTable
DROP TABLE "VmcHourlyCurrent";

-- DropTable
DROP TABLE "VmcHourlySnapshot";

-- DropTable
DROP TABLE "VmcRawResponse";

-- DropTable
DROP TABLE "VmcRun";

-- CreateTable
CREATE TABLE "CmcAsset" (
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dateAdded" TIMESTAMPTZ(3),
    "platformChain" TEXT,
    "platformAddress" TEXT,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastBatchId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CmcAsset_pkey" PRIMARY KEY ("providerId","cmcId")
);

-- CreateTable
CREATE TABLE "CmcAssetChange" (
    "id" BIGSERIAL NOT NULL,
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "batchId" UUID,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CmcAssetChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlBatch" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "slotTime" TIMESTAMPTZ(3) NOT NULL,
    "pipelineRunId" UUID,
    "isLive" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL,
    "crawledAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceUpdatedMin" TIMESTAMPTZ(3),
    "sourceUpdatedMax" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "statusReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "listedTotal" INTEGER,
    "collected" INTEGER NOT NULL,
    "fieldCounts" JSONB NOT NULL,
    "missingRanks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "duplicateRanks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "errors" JSONB,
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CrawlBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyMetric" (
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "dateUtc" DATE NOT NULL,
    "revisionId" BIGINT NOT NULL,
    "revision" INTEGER NOT NULL,
    "volumeUsd" DECIMAL(38,8),
    "marketCapUsd" DECIMAL(38,8),
    "closeUsd" DECIMAL(38,18),
    "vmc" DECIMAL(65,30),
    "valid" BOOLEAN NOT NULL,
    "invalidReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceCloseAt" TIMESTAMPTZ(3),
    "retrievedAt" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DailyMetric_pkey" PRIMARY KEY ("providerId","cmcId","dateUtc")
);

-- CreateTable
CREATE TABLE "DailyMetricRevision" (
    "id" BIGSERIAL NOT NULL,
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "dateUtc" DATE NOT NULL,
    "revision" INTEGER NOT NULL,
    "revisionReason" TEXT NOT NULL,
    "volumeUsd" DECIMAL(38,8),
    "marketCapUsd" DECIMAL(38,8),
    "openUsd" DECIMAL(38,18),
    "highUsd" DECIMAL(38,18),
    "lowUsd" DECIMAL(38,18),
    "closeUsd" DECIMAL(38,18),
    "valid" BOOLEAN NOT NULL,
    "invalidReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "periodStart" TIMESTAMPTZ(3),
    "periodEnd" TIMESTAMPTZ(3),
    "sourceCloseAt" TIMESTAMPTZ(3),
    "sourceFields" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "sourceParams" JSONB NOT NULL,
    "responseSha256" TEXT,
    "contentHash" TEXT NOT NULL,
    "retrievedAt" TIMESTAMPTZ(3) NOT NULL,
    "batchId" UUID,

    CONSTRAINT "DailyMetricRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyFetchState" (
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "lastAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastStatus" TEXT NOT NULL,
    "lastError" TEXT,
    "rowsReturned" INTEGER NOT NULL DEFAULT 0,
    "latestDateReturned" DATE,

    CONSTRAINT "DailyFetchState_pkey" PRIMARY KEY ("providerId","cmcId")
);

-- CreateTable
CREATE TABLE "VenueCrawl" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cmcId" INTEGER,
    "batchId" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "expectedCount" INTEGER,
    "fetchedCount" INTEGER NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "pairs" JSONB NOT NULL,
    "summary" JSONB,
    "source" TEXT NOT NULL,
    "sourceParams" JSONB NOT NULL,
    "responseSha256" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "VenueCrawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenuePairEvent" (
    "id" BIGSERIAL NOT NULL,
    "providerId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "marketPair" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "crawlId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VenuePairEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueDecision" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "exchange" TEXT NOT NULL,
    "marketPair" TEXT,
    "decision" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "note" TEXT,
    "batchId" UUID,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VenueDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueMappingTask" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "exchange" TEXT NOT NULL,
    "marketPair" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "firstSeenBatchId" UUID,
    "lastSeenBatchId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedByDecisionId" UUID,

    CONSTRAINT "VenueMappingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "batchId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "isLive" BOOLEAN NOT NULL,
    "rulesetVersion" TEXT NOT NULL,
    "configVersion" TEXT NOT NULL,
    "overridesVersion" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "asOf" TIMESTAMPTZ(3) NOT NULL,
    "queueStatus" TEXT,
    "counts" JSONB,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lbankCrawlId" UUID,
    "exportStatus" TEXT,
    "exportPath" TEXT,
    "exportFiles" JSONB,
    "exportedAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScanRun_pkey" PRIMARY KEY ("batchId")
);

-- CreateTable
CREATE TABLE "ScanResult" (
    "id" BIGSERIAL NOT NULL,
    "batchId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "rank" INTEGER,
    "dateAdded" TIMESTAMPTZ(3),
    "ageDays" DECIMAL(14,6),
    "priceUsd" DECIMAL(38,18),
    "capUsd" DECIMAL(38,8),
    "volume24hUsd" DECIMAL(38,8),
    "observedAt" TIMESTAMPTZ(3),
    "crawledAt" TIMESTAMPTZ(3) NOT NULL,
    "currentStatus" TEXT NOT NULL,
    "currentReason" TEXT,
    "currentVmc" DECIMAL(65,30),
    "vmc3dAvg" DECIMAL(65,30),
    "vmc7dAvg" DECIMAL(65,30),
    "vmc14dAvg" DECIMAL(65,30),
    "vmc30dAvg" DECIMAL(65,30),
    "avg3dReason" TEXT,
    "avg7dReason" TEXT,
    "avg14dReason" TEXT,
    "avg30dReason" TEXT,
    "multiple3d" DECIMAL(65,30),
    "multiple7d" DECIMAL(65,30),
    "multiple30d" DECIMAL(65,30),
    "pass3d" TEXT NOT NULL,
    "pass7d" TEXT NOT NULL,
    "pass30d" TEXT NOT NULL,
    "reason3d" TEXT,
    "reason7d" TEXT,
    "reason30d" TEXT,
    "stars" INTEGER NOT NULL,
    "eligibilityStatus" TEXT NOT NULL,
    "eligibilityReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assetClass" TEXT NOT NULL,
    "classSource" TEXT,
    "lbankStatus" TEXT NOT NULL,
    "lbankReason" TEXT,
    "lbankPairs" JSONB NOT NULL,
    "venueReview" TEXT NOT NULL,
    "venueFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inQueue" BOOLEAN NOT NULL DEFAULT false,
    "queueOrder" INTEGER,
    "diagnostics" JSONB,
    "dailyWindow" JSONB,
    "inputsHash" TEXT NOT NULL,
    "rulesetVersion" TEXT NOT NULL,
    "configVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScanResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "batchId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "supersedesId" UUID,
    "reviewer" TEXT NOT NULL,
    "reviewedAt" TIMESTAMPTZ(3) NOT NULL,
    "venueDecision" TEXT NOT NULL,
    "venueNote" TEXT,
    "eventDay" TEXT NOT NULL,
    "lbankPair" TEXT,
    "chartExchange" TEXT,
    "chartSymbol" TEXT,
    "chartQuote" TEXT,
    "chartUrl" TEXT,
    "chartTimezone" TEXT,
    "chartProxyReason" TEXT,
    "chartTimestamp" TIMESTAMPTZ(3),
    "rangeLow" TEXT,
    "chartHistory" TEXT,
    "priorPumpResponse" TEXT,
    "candleState" TEXT,
    "marketRegime" TEXT,
    "finalDecision" TEXT NOT NULL,
    "rationale" TEXT,
    "plan" JSONB,
    "planStatus" TEXT,
    "validation" JSONB NOT NULL,
    "tier1Snapshot" JSONB NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CmcAsset_providerId_symbol_idx" ON "CmcAsset"("providerId", "symbol");

-- CreateIndex
CREATE INDEX "CmcAssetChange_providerId_cmcId_observedAt_idx" ON "CmcAssetChange"("providerId", "cmcId", "observedAt");

-- CreateIndex
CREATE INDEX "CrawlBatch_providerId_crawledAt_idx" ON "CrawlBatch"("providerId", "crawledAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlBatch_providerId_slotTime_key" ON "CrawlBatch"("providerId", "slotTime");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMetric_revisionId_key" ON "DailyMetric"("revisionId");

-- CreateIndex
CREATE INDEX "DailyMetricRevision_providerId_cmcId_dateUtc_idx" ON "DailyMetricRevision"("providerId", "cmcId", "dateUtc");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMetricRevision_providerId_cmcId_dateUtc_revision_key" ON "DailyMetricRevision"("providerId", "cmcId", "dateUtc", "revision");

-- CreateIndex
CREATE INDEX "VenueCrawl_providerId_kind_finishedAt_idx" ON "VenueCrawl"("providerId", "kind", "finishedAt");

-- CreateIndex
CREATE INDEX "VenueCrawl_providerId_kind_cmcId_finishedAt_idx" ON "VenueCrawl"("providerId", "kind", "cmcId", "finishedAt");

-- CreateIndex
CREATE INDEX "VenuePairEvent_providerId_exchange_cmcId_at_idx" ON "VenuePairEvent"("providerId", "exchange", "cmcId", "at");

-- CreateIndex
CREATE INDEX "VenueDecision_providerId_cmcId_exchange_decidedAt_idx" ON "VenueDecision"("providerId", "cmcId", "exchange", "decidedAt");

-- CreateIndex
CREATE INDEX "VenueMappingTask_providerId_status_idx" ON "VenueMappingTask"("providerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VenueMappingTask_providerId_cmcId_exchange_marketPair_kind_key" ON "VenueMappingTask"("providerId", "cmcId", "exchange", "marketPair", "kind");

-- CreateIndex
CREATE INDEX "ScanRun_providerId_asOf_idx" ON "ScanRun"("providerId", "asOf");

-- CreateIndex
CREATE INDEX "ScanResult_batchId_eligibilityStatus_idx" ON "ScanResult"("batchId", "eligibilityStatus");

-- CreateIndex
CREATE INDEX "ScanResult_batchId_inQueue_idx" ON "ScanResult"("batchId", "inQueue");

-- CreateIndex
CREATE INDEX "ScanResult_providerId_cmcId_crawledAt_idx" ON "ScanResult"("providerId", "cmcId", "crawledAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScanResult_batchId_cmcId_key" ON "ScanResult"("batchId", "cmcId");

-- CreateIndex
CREATE INDEX "Review_providerId_cmcId_reviewedAt_idx" ON "Review"("providerId", "cmcId", "reviewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Review_providerId_cmcId_batchId_revision_key" ON "Review"("providerId", "cmcId", "batchId", "revision");


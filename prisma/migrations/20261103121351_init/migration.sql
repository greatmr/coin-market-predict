-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessMethod" TEXT NOT NULL,
    "isLive" BOOLEAN NOT NULL,
    "baseUrl" TEXT,
    "termsUrl" TEXT,
    "attribution" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL DEFAULT 'unknown',
    "classSource" TEXT,
    "underlyingAsset" TEXT,
    "isBenchmark" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "delistedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetIdentity" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerAssetId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "delistedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AssetIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetContract" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "decimals" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "assetsSeen" INTEGER NOT NULL DEFAULT 0,
    "newAssets" INTEGER NOT NULL DEFAULT 0,
    "delistedAssets" INTEGER NOT NULL DEFAULT 0,
    "sourceTotal" INTEGER,
    "coverageComplete" BOOLEAN NOT NULL DEFAULT false,
    "requestsUsed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "notes" JSONB,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceHealth" (
    "providerId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'closed',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveDenials" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMPTZ(3),
    "retryAfterUntil" TIMESTAMPTZ(3),
    "suspendedReason" TEXT,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastFailureAt" TIMESTAMPTZ(3),
    "lastStatusCode" INTEGER,
    "budgetPeriodStart" TIMESTAMPTZ(3),
    "budgetUsed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SourceHealth_pkey" PRIMARY KEY ("providerId")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "assetId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerAssetId" TEXT NOT NULL,
    "slotTime" TIMESTAMPTZ(3) NOT NULL,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL,
    "observedAt" TIMESTAMPTZ(3),
    "sourceUrl" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL DEFAULT 'USD',
    "price" DECIMAL(38,18),
    "marketCap" DECIMAL(38,4),
    "marketCapProvenance" TEXT NOT NULL,
    "fullyDilutedValuation" DECIMAL(38,4),
    "circulatingSupply" DECIMAL(38,8),
    "supplyProvenance" TEXT NOT NULL,
    "volumeRolling24h" DECIMAL(38,4),
    "volumeHourly" DECIMAL(38,4),
    "volumeHourlySource" TEXT,
    "providerChangePct1h" DECIMAL(20,8),
    "providerChangePct24h" DECIMAL(20,8),
    "providerChangePct7d" DECIMAL(20,8),
    "bidAskSpreadPct" DECIMAL(20,8),
    "depthPlus2PctUsd" DECIMAL(38,4),
    "depthMinus2PctUsd" DECIMAL(38,4),
    "liquiditySource" TEXT,
    "qualityFlags" TEXT[],
    "completeness" DECIMAL(5,4) NOT NULL,
    "freshnessSeconds" INTEGER,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "nullReasons" JSONB NOT NULL,
    "pipelineRunId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "slotTime" TIMESTAMPTZ(3) NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentStage" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "coverage" JSONB,
    "metrics" JSONB,
    "modelCostUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "error" TEXT,
    "isLiveData" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "detail" JSONB,
    "error" TEXT,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppState" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppState_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMPTZ(3) NOT NULL,
    "heartbeatAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "FeatureSetVersion" (
    "version" TEXT NOT NULL,
    "definitions" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureSetVersion_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "StrategyVersion" (
    "version" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "researchTarget" JSONB NOT NULL,
    "featureSetVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "FeatureValue" (
    "id" BIGSERIAL NOT NULL,
    "assetId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "slotTime" TIMESTAMPTZ(3) NOT NULL,
    "featureSetVersion" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "unavailable" JSONB NOT NULL,
    "historyDepth" INTEGER NOT NULL,
    "warmupState" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningResult" (
    "id" BIGSERIAL NOT NULL,
    "runId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "slotTime" TIMESTAMPTZ(3) NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "exclusionReasons" TEXT[],
    "classification" TEXT NOT NULL,
    "heuristicScore" DECIMAL(7,3) NOT NULL,
    "components" JSONB NOT NULL,
    "riskFlags" TEXT[],
    "rank" INTEGER,
    "shortlisted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ScreeningResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "slotTime" TIMESTAMPTZ(3) NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "horizonHours" INTEGER NOT NULL,
    "heuristicScore" DECIMAL(7,3) NOT NULL,
    "agentScore" DECIMAL(7,3),
    "calibratedProbability" DECIMAL(7,6),
    "evidence" JSONB NOT NULL,
    "counterevidence" JSONB NOT NULL,
    "dataQuality" JSONB NOT NULL,
    "entryTrigger" TEXT NOT NULL,
    "invalidation" TEXT NOT NULL,
    "exitConditions" JSONB NOT NULL,
    "scenario" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "rationale" TEXT NOT NULL,
    "riskFlags" TEXT[],
    "origin" TEXT NOT NULL,
    "reviewOutcome" TEXT,
    "evidenceHash" TEXT NOT NULL,
    "isLiveData" BOOLEAN NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" UUID NOT NULL,
    "runId" UUID,
    "role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "numTurns" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "costUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "errorKind" TEXT,
    "errorMessage" TEXT,
    "output" JSONB,
    "toolCalls" JSONB,
    "sessionId" TEXT,

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramDelivery" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "reportHash" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "partCount" INTEGER NOT NULL,
    "chatId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "telegramMessageId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),

    CONSTRAINT "TelegramDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperPosition" (
    "id" UUID NOT NULL,
    "signalId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "referencePrice" DECIMAL(38,18) NOT NULL,
    "entryTriggerPrice" DECIMAL(38,18) NOT NULL,
    "stopPrice" DECIMAL(38,18) NOT NULL,
    "targetPrice" DECIMAL(38,18) NOT NULL,
    "trailingStopPct" DECIMAL(10,6),
    "maxHoldHours" INTEGER NOT NULL,
    "signalExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "entryAt" TIMESTAMPTZ(3),
    "entryPrice" DECIMAL(38,18),
    "highWaterPrice" DECIMAL(38,18),
    "exitAt" TIMESTAMPTZ(3),
    "exitPrice" DECIMAL(38,18),
    "exitReason" TEXT,
    "grossReturn" DECIMAL(20,10),
    "netReturn" DECIMAL(20,10),
    "maxAdverseExcursion" DECIMAL(20,10),
    "ambiguousOrdering" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaperPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalOutcome" (
    "id" UUID NOT NULL,
    "signalId" UUID NOT NULL,
    "targetVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "horizonHours" INTEGER NOT NULL,
    "evaluatedAt" TIMESTAMPTZ(3),
    "maxReturn" DECIMAL(20,10),
    "minReturn" DECIMAL(20,10),
    "finalReturn" DECIMAL(20,10),
    "benchmarkReturn" DECIMAL(20,10),
    "observations" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT[],

    CONSTRAINT "SignalOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestReport" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "strategyVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3),
    "periodEnd" TIMESTAMPTZ(3),
    "isLiveData" BOOLEAN NOT NULL,
    "includesFinalTest" BOOLEAN NOT NULL DEFAULT false,
    "report" JSONB NOT NULL,

    CONSTRAINT "BacktestReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Asset_symbol_idx" ON "Asset"("symbol");

-- CreateIndex
CREATE INDEX "Asset_assetClass_idx" ON "Asset"("assetClass");

-- CreateIndex
CREATE INDEX "AssetIdentity_assetId_idx" ON "AssetIdentity"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetIdentity_providerId_providerAssetId_key" ON "AssetIdentity"("providerId", "providerAssetId");

-- CreateIndex
CREATE INDEX "AssetContract_assetId_idx" ON "AssetContract"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetContract_chain_contractAddress_key" ON "AssetContract"("chain", "contractAddress");

-- CreateIndex
CREATE INDEX "DiscoveryRun_providerId_startedAt_idx" ON "DiscoveryRun"("providerId", "startedAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_assetId_slotTime_idx" ON "MarketSnapshot"("assetId", "slotTime");

-- CreateIndex
CREATE INDEX "MarketSnapshot_slotTime_idx" ON "MarketSnapshot"("slotTime");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSnapshot_providerId_providerAssetId_slotTime_quoteCur_key" ON "MarketSnapshot"("providerId", "providerAssetId", "slotTime", "quoteCurrency");

-- CreateIndex
CREATE INDEX "PipelineRun_startedAt_idx" ON "PipelineRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineRun_kind_slotTime_providerId_key" ON "PipelineRun"("kind", "slotTime", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_runId_stage_key" ON "PipelineStage"("runId", "stage");

-- CreateIndex
CREATE INDEX "FeatureValue_slotTime_idx" ON "FeatureValue"("slotTime");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureValue_assetId_providerId_slotTime_featureSetVersion_key" ON "FeatureValue"("assetId", "providerId", "slotTime", "featureSetVersion");

-- CreateIndex
CREATE INDEX "ScreeningResult_slotTime_shortlisted_idx" ON "ScreeningResult"("slotTime", "shortlisted");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningResult_runId_assetId_strategyVersion_key" ON "ScreeningResult"("runId", "assetId", "strategyVersion");

-- CreateIndex
CREATE INDEX "Signal_slotTime_status_idx" ON "Signal"("slotTime", "status");

-- CreateIndex
CREATE INDEX "Signal_evidenceHash_idx" ON "Signal"("evidenceHash");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_runId_assetId_strategyVersion_key" ON "Signal"("runId", "assetId", "strategyVersion");

-- CreateIndex
CREATE INDEX "AgentExecution_role_evidenceHash_status_idx" ON "AgentExecution"("role", "evidenceHash", "status");

-- CreateIndex
CREATE INDEX "AgentExecution_startedAt_idx" ON "AgentExecution"("startedAt");

-- CreateIndex
CREATE INDEX "TelegramDelivery_status_nextAttemptAt_idx" ON "TelegramDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramDelivery_reportHash_partIndex_chatId_key" ON "TelegramDelivery"("reportHash", "partIndex", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperPosition_signalId_key" ON "PaperPosition"("signalId");

-- CreateIndex
CREATE INDEX "PaperPosition_status_idx" ON "PaperPosition"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SignalOutcome_signalId_targetVersion_key" ON "SignalOutcome"("signalId", "targetVersion");

-- AddForeignKey
ALTER TABLE "AssetIdentity" ADD CONSTRAINT "AssetIdentity_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetIdentity" ADD CONSTRAINT "AssetIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetContract" ADD CONSTRAINT "AssetContract_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceHealth" ADD CONSTRAINT "SourceHealth_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureValue" ADD CONSTRAINT "FeatureValue_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningResult" ADD CONSTRAINT "ScreeningResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningResult" ADD CONSTRAINT "ScreeningResult_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramDelivery" ADD CONSTRAINT "TelegramDelivery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperPosition" ADD CONSTRAINT "PaperPosition_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalOutcome" ADD CONSTRAINT "SignalOutcome_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

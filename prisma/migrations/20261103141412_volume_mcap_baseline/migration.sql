-- CreateTable
CREATE TABLE "VmcAsset" (
    "cmcId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "isActive" BOOLEAN,
    "firstHistoricalAt" TIMESTAMPTZ(3),
    "lastHistoricalAt" TIMESTAMPTZ(3),
    "hourlyBackfilledAt" TIMESTAMPTZ(3),
    "metadataSource" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VmcAsset_pkey" PRIMARY KEY ("cmcId")
);

-- CreateTable
CREATE TABLE "VmcAssetMetadataChange" (
    "id" BIGSERIAL NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "runId" UUID,

    CONSTRAINT "VmcAssetMetadataChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmcRun" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "isFixture" BOOLEAN NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "config" JSONB NOT NULL,
    "creditsUsed" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "VmcRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmcAssetResult" (
    "id" BIGSERIAL NOT NULL,
    "runId" UUID NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "error" TEXT,

    CONSTRAINT "VmcAssetResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmcRawResponse" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" INTEGER,
    "creditCount" INTEGER,
    "retrievedAt" TIMESTAMPTZ(3) NOT NULL,
    "bodySha256" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isFixture" BOOLEAN NOT NULL,

    CONSTRAINT "VmcRawResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmcDailyObservation" (
    "id" BIGSERIAL NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "dateUtc" DATE NOT NULL,
    "convention" TEXT NOT NULL,
    "sourceTimestamp" TIMESTAMPTZ(3),
    "periodStart" TIMESTAMPTZ(3),
    "periodEnd" TIMESTAMPTZ(3),
    "volumeUsd" DECIMAL(38,8),
    "marketCapUsd" DECIMAL(38,8),
    "ratio" DECIMAL(38,18),
    "valid" BOOLEAN NOT NULL,
    "invalidReasons" TEXT[],
    "revision" INTEGER NOT NULL,
    "revisionReason" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceFields" JSONB NOT NULL,
    "rawResponseId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "retrievedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VmcDailyObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmcDailyCurrent" (
    "cmcId" INTEGER NOT NULL,
    "dateUtc" DATE NOT NULL,
    "convention" TEXT NOT NULL,
    "observationId" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VmcDailyCurrent_pkey" PRIMARY KEY ("cmcId","dateUtc","convention")
);

-- CreateTable
CREATE TABLE "VmcHourlySnapshot" (
    "id" BIGSERIAL NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "hourBucket" TIMESTAMPTZ(3) NOT NULL,
    "scheduledHour" TIMESTAMPTZ(3),
    "observedAt" TIMESTAMPTZ(3),
    "collectedAt" TIMESTAMPTZ(3) NOT NULL,
    "volume24hUsd" DECIMAL(38,8),
    "marketCapUsd" DECIMAL(38,8),
    "ratio" DECIMAL(38,18),
    "origin" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "valid" BOOLEAN NOT NULL,
    "invalidReasons" TEXT[],
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL,
    "revisionReason" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceFields" JSONB NOT NULL,
    "rawResponseId" UUID NOT NULL,
    "runId" UUID NOT NULL,

    CONSTRAINT "VmcHourlySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmcHourlyCurrent" (
    "cmcId" INTEGER NOT NULL,
    "hourBucket" TIMESTAMPTZ(3) NOT NULL,
    "snapshotId" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VmcHourlyCurrent_pkey" PRIMARY KEY ("cmcId","hourBucket")
);

-- CreateTable
CREATE TABLE "VmcBaseline" (
    "id" UUID NOT NULL,
    "cmcId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "formulaVersion" TEXT NOT NULL,
    "convention" TEXT NOT NULL,
    "windowStart" DATE NOT NULL,
    "windowEnd" DATE NOT NULL,
    "expectedDays" INTEGER NOT NULL,
    "returnedDays" INTEGER NOT NULL,
    "validDays" INTEGER NOT NULL,
    "invalidDays" INTEGER NOT NULL,
    "missingDays" INTEGER NOT NULL,
    "coverage" DECIMAL(9,6) NOT NULL,
    "status" TEXT NOT NULL,
    "statusReasons" TEXT[],
    "ratioSum" DECIMAL(48,18),
    "meanRatio" DECIMAL(38,18),
    "firstValidDate" DATE,
    "lastValidDate" DATE,
    "inputsHash" TEXT NOT NULL,
    "calculatedAt" TIMESTAMPTZ(3) NOT NULL,
    "runId" UUID NOT NULL,

    CONSTRAINT "VmcBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VmcBaselineMember" (
    "baselineId" UUID NOT NULL,
    "observationId" BIGINT NOT NULL,
    "dateUtc" DATE NOT NULL,
    "ratio" DECIMAL(38,18),
    "included" BOOLEAN NOT NULL,
    "reason" TEXT,

    CONSTRAINT "VmcBaselineMember_pkey" PRIMARY KEY ("baselineId","observationId")
);

-- CreateIndex
CREATE INDEX "VmcAsset_symbol_idx" ON "VmcAsset"("symbol");

-- CreateIndex
CREATE INDEX "VmcAssetMetadataChange_cmcId_observedAt_idx" ON "VmcAssetMetadataChange"("cmcId", "observedAt");

-- CreateIndex
CREATE INDEX "VmcRun_job_startedAt_idx" ON "VmcRun"("job", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VmcAssetResult_runId_cmcId_key" ON "VmcAssetResult"("runId", "cmcId");

-- CreateIndex
CREATE INDEX "VmcRawResponse_endpoint_retrievedAt_idx" ON "VmcRawResponse"("endpoint", "retrievedAt");

-- CreateIndex
CREATE INDEX "VmcDailyObservation_cmcId_convention_dateUtc_idx" ON "VmcDailyObservation"("cmcId", "convention", "dateUtc");

-- CreateIndex
CREATE UNIQUE INDEX "VmcDailyObservation_cmcId_dateUtc_convention_revision_key" ON "VmcDailyObservation"("cmcId", "dateUtc", "convention", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "VmcDailyCurrent_observationId_key" ON "VmcDailyCurrent"("observationId");

-- CreateIndex
CREATE INDEX "VmcHourlySnapshot_cmcId_hourBucket_idx" ON "VmcHourlySnapshot"("cmcId", "hourBucket");

-- CreateIndex
CREATE UNIQUE INDEX "VmcHourlySnapshot_cmcId_hourBucket_revision_key" ON "VmcHourlySnapshot"("cmcId", "hourBucket", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "VmcHourlyCurrent_snapshotId_key" ON "VmcHourlyCurrent"("snapshotId");

-- CreateIndex
CREATE INDEX "VmcBaseline_cmcId_calculatedAt_idx" ON "VmcBaseline"("cmcId", "calculatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VmcBaseline_cmcId_version_key" ON "VmcBaseline"("cmcId", "version");

-- AddForeignKey
ALTER TABLE "VmcAssetMetadataChange" ADD CONSTRAINT "VmcAssetMetadataChange_cmcId_fkey" FOREIGN KEY ("cmcId") REFERENCES "VmcAsset"("cmcId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VmcAssetResult" ADD CONSTRAINT "VmcAssetResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "VmcRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VmcRawResponse" ADD CONSTRAINT "VmcRawResponse_runId_fkey" FOREIGN KEY ("runId") REFERENCES "VmcRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VmcBaselineMember" ADD CONSTRAINT "VmcBaselineMember_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "VmcBaseline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

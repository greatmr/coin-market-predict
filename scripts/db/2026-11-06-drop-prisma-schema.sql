-- One-time cleanup after the move from Prisma to TypeORM (2026-11-06, docs/adr/0001-typeorm-modular-layout.md).
--
-- Order: stop the app → backup → `npm run db:migrate` → the carry-over script
-- (2026-11-06-carry-over-prisma-state.sql) → THIS SCRIPT. Full procedure: docs/operator-guide.md § 9.
--
-- Drops the retired Prisma tables (quoted CamelCase names) and Prisma's migration history. The
-- TypeORM schema uses different, snake_case names (provider, crawl_batch, …), so nothing here
-- touches it. The Prisma schema had no enum types, so there are none to drop. Market data in these
-- tables is NOT migrated (refill by running the pipeline); the guards below refuse to run before
-- the TypeORM schema exists or while Telegram state that was not carried over would be lost.
--
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < scripts/db/2026-11-06-drop-prisma-schema.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.migrations') IS NULL OR to_regclass('public.app_state') IS NULL THEN
    RAISE EXCEPTION 'TypeORM schema missing: run npm run db:migrate and the carry-over script first';
  END IF;
  IF to_regclass('public."AppState"') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM "AppState" o
      WHERE o.key IN ('telegram.access', 'telegram.updateOffset')
        AND NOT EXISTS (SELECT 1 FROM app_state n WHERE n.key = o.key)
    ) THEN
      RAISE EXCEPTION 'Telegram state not carried over: run scripts/db/2026-11-06-carry-over-prisma-state.sql first';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS
  "Review",
  "ScanResult",
  "ScanRun",
  "VenueMappingTask",
  "VenueDecision",
  "VenuePairEvent",
  "VenueCrawl",
  "DailyFetchState",
  "DailyMetricRevision",
  "DailyMetric",
  "CrawlBatch",
  "CmcAssetChange",
  "CmcAsset",
  "TelegramDelivery",
  "JobLease",
  "AppState",
  "PipelineStage",
  "PipelineRun",
  "MarketSnapshot",
  "SourceHealth",
  "DiscoveryRun",
  "AssetContract",
  "AssetIdentity",
  "Asset",
  "Provider",
  _prisma_migrations
CASCADE;

COMMIT;

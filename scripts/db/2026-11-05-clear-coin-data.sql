-- One-time, scoped clear of coin-related data before the Two-Tier VMC migration (2026-11-05).
-- Scope and reasons: docs/implementation-plan.md §7. Run only after a verified backup:
--   docker compose exec -T postgres psql -U coins -d coins -v ON_ERROR_STOP=1 -f - < scripts/db/2026-11-05-clear-coin-data.sql
-- Explicit DELETEs, children before parents (foreign keys are RESTRICT, so a missed dependent
-- aborts). Preserved rows are fingerprinted before and after; any difference rolls everything back.

BEGIN;

CREATE TEMP TABLE _preserved_before ON COMMIT DROP AS
SELECT 'Provider' AS t, count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "Provider" x
UNION ALL SELECT 'SourceHealth', count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM "SourceHealth" x
UNION ALL SELECT 'JobLease', count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM "JobLease" x
UNION ALL SELECT 'AppState.telegram', count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM "AppState" x WHERE key LIKE 'telegram.%'
UNION ALL SELECT '_prisma_migrations', count(*), md5(coalesce(string_agg(x.id || x.checksum, '|' ORDER BY x.id), '')) FROM _prisma_migrations x;

-- 1. Six-month VMC module (observations, baselines, runs)
DELETE FROM "VmcBaselineMember";
DELETE FROM "VmcBaseline";
DELETE FROM "VmcAssetResult";
DELETE FROM "VmcRawResponse";
DELETE FROM "VmcRun";
DELETE FROM "VmcDailyCurrent";
DELETE FROM "VmcDailyObservation";
DELETE FROM "VmcHourlyCurrent";
DELETE FROM "VmcHourlySnapshot";
DELETE FROM "VmcAssetMetadataChange";
DELETE FROM "VmcAsset";

-- 2. Predictions, features and research results
DELETE FROM "PaperPosition";
DELETE FROM "SignalOutcome";
DELETE FROM "Signal";
DELETE FROM "AgentExecution";
DELETE FROM "ScreeningResult";
DELETE FROM "FeatureValue";
DELETE FROM "BacktestReport";
DELETE FROM "StrategyVersion";
DELETE FROM "FeatureSetVersion";

-- 3. Coin report deliveries and run records
DELETE FROM "TelegramDelivery";
DELETE FROM "PipelineStage";
DELETE FROM "PipelineRun";
DELETE FROM "DiscoveryRun";

-- 4. Coin observations
DELETE FROM "MarketSnapshot";

-- 5. Coin identities (rebuilt by the next discovery/collect)
DELETE FROM "AssetContract";
DELETE FROM "AssetIdentity";
DELETE FROM "Asset";

-- 6. State of removed modules (old VMC capability probe, old fixture market anchor)
DELETE FROM "AppState" WHERE key IN ('vmc.capabilities', 'fixture.anchorSlot');

DO $$
DECLARE
  t text;
  n bigint;
  bad text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['VmcBaselineMember','VmcBaseline','VmcAssetResult','VmcRawResponse','VmcRun','VmcDailyCurrent',
    'VmcDailyObservation','VmcHourlyCurrent','VmcHourlySnapshot','VmcAssetMetadataChange','VmcAsset','PaperPosition',
    'SignalOutcome','Signal','AgentExecution','ScreeningResult','FeatureValue','BacktestReport','StrategyVersion',
    'FeatureSetVersion','TelegramDelivery','PipelineStage','PipelineRun','DiscoveryRun','MarketSnapshot','AssetContract',
    'AssetIdentity','Asset'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n <> 0 THEN bad := bad || format(' %s=%s', t, n); END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'clear incomplete:%', bad; END IF;

  IF EXISTS (
    SELECT 1 FROM _preserved_before b
    FULL JOIN (
      SELECT 'Provider' AS t, count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "Provider" x
      UNION ALL SELECT 'SourceHealth', count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM "SourceHealth" x
      UNION ALL SELECT 'JobLease', count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM "JobLease" x
      UNION ALL SELECT 'AppState.telegram', count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM "AppState" x WHERE key LIKE 'telegram.%'
      UNION ALL SELECT '_prisma_migrations', count(*), md5(coalesce(string_agg(x.id || x.checksum, '|' ORDER BY x.id), '')) FROM _prisma_migrations x
    ) a USING (t)
    WHERE b.n IS DISTINCT FROM a.n OR b.h IS DISTINCT FROM a.h
  ) THEN
    RAISE EXCEPTION 'preserved data changed; rolling back';
  END IF;
END $$;

SELECT t AS preserved_table, n AS rows, h AS fingerprint FROM _preserved_before ORDER BY t;

COMMIT;

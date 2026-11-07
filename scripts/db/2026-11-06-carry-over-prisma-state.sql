-- One-time carry-over for the Prisma → TypeORM cut-over (2026-11-06, docs/adr/0001-typeorm-modular-layout.md).
--
-- Order: stop the app → backup → `npm run db:migrate` (creates the snake_case TypeORM tables next to
-- the old quoted CamelCase ones; the names never collide) → THIS SCRIPT → the drop script.
--
-- Copies only operational state that is not market data:
--   provider       the source registry (source_health references it)
--   source_health  circuit state and the monthly website request budget, so the budget is not
--                  reset in the middle of a month
--   app_state      telegram.access (owner-approved members) and telegram.updateOffset, so the bot
--                  neither forgets its members nor re-reads and re-executes commands it already handled
-- Market data, scans, reviews, decisions, runs and deliveries are not copied (operator decision,
-- 2026-11-06: refill by running the pipeline). Rows already present in the new tables are kept, so
-- running the script twice changes nothing. Prints table names, counts and keys, never values.
--
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < scripts/db/2026-11-06-carry-over-prisma-state.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.app_state') IS NULL THEN
    RAISE EXCEPTION 'TypeORM schema missing: run npm run db:migrate first';
  END IF;
  IF to_regclass('public."Provider"') IS NULL THEN
    RAISE EXCEPTION 'No Prisma tables found: nothing to carry over (already dropped?)';
  END IF;
END $$;

INSERT INTO provider (id, name, access_method, is_live, base_url, terms_url, attribution, created_at, updated_at)
SELECT id, name, "accessMethod"::provider_access_method, "isLive", "baseUrl", "termsUrl", attribution,
       "createdAt", "updatedAt"
FROM "Provider"
ON CONFLICT (id) DO NOTHING;

INSERT INTO source_health (provider_id, state, consecutive_failures, consecutive_denials, opened_at,
                           retry_after_until, suspended_reason, last_success_at, last_failure_at,
                           last_status_code, budget_period_start, budget_used, updated_at)
SELECT "providerId", state::circuit_state, "consecutiveFailures", "consecutiveDenials", "openedAt",
       "retryAfterUntil", "suspendedReason", "lastSuccessAt", "lastFailureAt",
       "lastStatusCode", "budgetPeriodStart", "budgetUsed", "updatedAt"
FROM "SourceHealth"
ON CONFLICT (provider_id) DO NOTHING;

INSERT INTO app_state (key, value, updated_at)
SELECT key, value, "updatedAt"
FROM "AppState"
WHERE key IN ('telegram.access', 'telegram.updateOffset')
ON CONFLICT (key) DO NOTHING;

COMMIT;

SELECT 'provider' AS "table", count(*) AS "rows" FROM provider
UNION ALL SELECT 'source_health', count(*) FROM source_health
UNION ALL SELECT 'app_state', count(*) FROM app_state;
SELECT key AS "carried app_state key" FROM app_state ORDER BY key;

# ADR-0001 — TypeORM, modular layout and database conventions

**Status:** Accepted, 2026-11-06 (operator request: adopt the standard backend layout and database
structure of the Agentic-Fellowa back-end; existing data need not be preserved).

## Context
The application used Prisma 7 with quoted CamelCase tables and camelCase columns, free-text status
columns, and a flat `src/<area>/` layout in which strategy rules, I/O services and HTTP code sat
side by side. The operator's standard backend (NestJS + TypeORM) organizes code as
`src/modules/<name>/{dto,entities}`, `src/common/*`, `src/config/env.validation.ts`,
`src/database/{data-source,typeorm-options,naming strategy,migrations}` and `src/health/`, with
snake_case tables, PostgreSQL enums, named constraints, declared foreign keys, raw-SQL migrations
and a `{ data, errors }` response envelope.

## Decision
1. **ORM**: TypeORM 0.3.31 with `@nestjs/typeorm` 12.0.2 (TypeORM 1.x requires Node ≥ 22.13; the
   project supports ≥ 22.12). One options builder, `database/typeorm-options.ts`, serves the
   application and the TypeORM CLI. `synchronize`, `migrationsRun` and `installExtensions` are
   the literal `false`; booting never alters a database.
2. **Layout**: one Nest module per domain area under `src/modules/` (sources, ingestion,
   daily-metrics, venues, scan, exports, reviews, pipeline, telegram, read-model, dashboard, mcp,
   app-state, strategy), cross-cutting code in `src/common/`, liveness at `GET /healthz`. The
   strategy rules form their own module ([ADR-0002](0002-strategy-module-boundary.md)).
3. **Schema conventions**: snake_case tables and columns; a PostgreSQL enum type for every closed
   value set, with values taken from code constants (strategy-owned sets from the strategy
   module); constraint names `<table>_pkey`, `<table>_<cols>_fkey`, and explicit `ux_*` (unique)
   and `ix_*` (index) names; every reference to another row is a declared foreign key (external
   identifiers such as CMC ids and Telegram chat ids are plain columns). Required references are
   `ON DELETE RESTRICT`, so history is never deleted implicitly; rows owned by a run cascade with
   it (`pipeline_stage`, `telegram_delivery`); optional provenance links (`pipeline_run_id`, a
   crawl's or revision's `batch_id`, …) are `SET NULL`.
4. **Kept from the old model**: UUID keys (`gen_random_uuid()`, built into PostgreSQL ≥ 13) and
   bigint identity keys for high-volume rows; `timestamptz` everywhere (UTC); numeric precision
   identical to the Prisma schema (prices `numeric(38,18)`, caps and volumes `numeric(38,4)` /
   `(38,8)` as the source supplies them, ratios and multiples `numeric(65,30)`); numerics are read
   as exact decimals (`D`, decimal.js), never JS floats; `date` columns stay `'YYYY-MM-DD'` text.
5. **Migrations**: hand-written raw SQL (`src/database/migrations/M001…M006`), reviewed like code,
   applied only by `npm run db:migrate` (or `RUN_MIGRATIONS=true` in Docker). Applied migrations
   are never edited. The e2e test `test/schema-drift.e2e-spec.ts` fails when TypeORM's schema
   builder finds any difference between the migrated database and the entities.
6. **Module format**: the project stays native ESM (`.js` import suffixes; NestJS 12 ships ESM
   only) with Vitest + SWC, unlike the CommonJS + Jest reference. Entity and migration lists are
   therefore explicit arrays (`database/entities.ts`, `database/migrations/index.ts`) rather than
   globs; unit tests fail when a file is not registered.
7. **HTTP contract**: `/api/*` responses use `{ data, errors }` with stable error codes
   (`common/dto/error-codes.ts`); Zod validates every body, query and parameter. `/mcp`, `/healthz`
   and export downloads are not enveloped.
8. **Tooling**: Prettier (single quotes, width 100, grouped imports) and an ESLint flat config.
   Unit specs live next to the code (`src/**/*.spec.ts`); database tests are `test/**/*.e2e-spec.ts`.

## Consequences
- \+ The layout and database conventions match the operator's other backend; the database itself
  now enforces status values and references that the code previously enforced alone.
- \+ Drift between entities and migrations is caught by a test instead of in production.
- − Existing databases need a one-time cut-over: migrate, carry over provider / source health /
  Telegram state, drop the Prisma tables (`scripts/db/2026-11-06-*.sql`, procedure in
  [operator-guide § 9](../operator-guide.md#9-backup-restore-and-migrations)). Market data, scans
  and reviews are not migrated; the pipeline refills market data.
- − API clients must read `body.data` (the dashboard does); MCP tools are unchanged.
- − Adding an entity or migration means registering it in its list; migration commands compile
  first (about 2 s) so they never run a stale build.

## Alternatives rejected
- **Keep Prisma**: does not match the standard layout or its migration and naming conventions.
- **TypeORM 1.x**: requires Node ≥ 22.13.
- **`synchronize` in development**: lets the schema drift from the reviewed migrations.
- **CommonJS + Jest to mirror the reference exactly**: NestJS 12 is ESM-only; Vitest was in place.
- **Migrate the Prisma data**: the operator chose to refill instead; only state that cannot be
  refilled from the source is carried over.

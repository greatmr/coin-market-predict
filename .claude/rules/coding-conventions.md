---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---
# Coding conventions

- Native ESM: relative imports end in `.js`. Node ≥ 22.12, TypeScript strict,
  `noUncheckedIndexedAccess`. Format and lint with `npm run format` / `npm run lint`.
- Layout (`docs/adr/0001`): one Nest module per area in `src/modules/<name>/` with its entities in
  `entities/` and request DTOs in `dto/`; cross-cutting code in `src/common/`; HTTP routes only in
  `modules/dashboard` (plus `health`, `mcp`). Unit specs sit next to the code (`*.spec.ts`).
- The strategy (`docs/adr/0002`) lives in `src/modules/strategy/`: pure functions and constants,
  no database, HTTP or other modules. Use it only through `modules/strategy/index.js` (ESLint
  rejects deep imports). Other pure logic stays pure too (`telegram/format.ts`, parsers), so it is
  unit-testable without a database.
- Ratios and comparisons use exact decimals (`common/utils/decimal.ts`, `D`), never JS floats;
  round only for storage (`forStorage`) or display.
- Validate every external input with Zod (env, HTTP bodies / query / params via
  `ZodValidationPipe`, MCP tool args, override file, review records). HTTP errors throw a Nest
  exception with `{ message, code }` from `common/dto/error-codes.ts`; the global interceptor
  wraps responses as `{ data, errors }`.
- TypeORM entities: snake_case `name` and an explicit `type` on every column; numerics via
  `DecimalColumn` (read as `D`); `date` columns typed `string` (`YYYY-MM-DD`); enum columns with
  `enumName` and values from a code constant; every reference to another row a `@ManyToOne`
  with an explicit `onDelete`. Register new entities in `src/database/entities.ts`.
- Schema changes only through a new raw-SQL migration in `src/database/migrations/` (draft with
  `npm run migration:generate -- src/database/migrations/<Name>` or `migration:create`, review
  it, register it in `migrations/index.ts`); never edit an applied migration. Never
  `synchronize`, `schema:sync`, `schema:drop` or `db:revert` against real data; never delete the
  `coins_pgdata` volume.
- Idempotent writes on the unique keys: `INSERT … ON CONFLICT DO NOTHING`
  (`insertRows(…, { ignoreConflicts: true })`, `.orIgnore()`) or upserts (`.orUpdate()`).
- Keep comments sparse and about *why*. Match existing naming.

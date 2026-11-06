---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---
# Coding conventions

- Native ESM: relative imports end in `.js`. Node ≥ 22.12, TypeScript strict,
  `noUncheckedIndexedAccess`.
- NestJS DI for services; pure functions for rules and math (`tier1/eligibility.ts`,
  `tier1/vmc.ts`, `tier1/lbank.ts`, `tier1/queue.ts`, `tier1/review-rules.ts`,
  `telegram/format.ts`) so they are unit-testable without a database.
- Ratios and comparisons use exact decimals (`common/decimal.ts`, `D`), never JS floats; round
  only for storage (`forStorage`) or display.
- Validate every external input with Zod (env, HTTP bodies and query params, MCP tool args,
  override file, review records).
- Prisma: Decimal for money/ratio columns; convert with `toNum()`/`plain()` at boundaries.
  Schema changes only via versioned migrations (`npx prisma migrate dev --name …`, or
  `migrate diff` + `migrate deploy` when non-interactive); never `db push` or `--force-reset`,
  never delete the `coins_pgdata` volume.
- Idempotent writes: `createMany({ skipDuplicates })` / `upsert` on the unique keys.
- Keep comments sparse and about *why*. Match existing naming.

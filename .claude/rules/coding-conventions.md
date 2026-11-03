---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---
# Coding conventions

- Native ESM: relative imports end in `.js`. Node ≥ 22.12, TypeScript strict,
  `noUncheckedIndexedAccess`.
- NestJS DI for services; pure functions for math (`features/compute.ts`, `screening/screen.ts`,
  `evaluation/*.ts`, `telegram/format.ts`) so they are unit-testable without a database.
- Validate every external input with Zod (env, HTTP query params, MCP tool args, agent output).
- Prisma: Decimal for money columns; convert with `toNum()`/`plain()` at boundaries.
  Schema changes only via `npx prisma migrate dev --name …`; never `db push` or
  `--force-reset`, never delete the `coins_pgdata` volume.
- Idempotent writes: `createMany({ skipDuplicates })` / `upsert` on the unique keys.
- Keep comments sparse and about *why*. Match existing naming.

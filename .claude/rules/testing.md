---
paths:
  - "test/**"
  - "src/**/*.spec.ts"
  - "vitest.config.ts"
---
# Testing

- Unit specs (`src/**/*.spec.ts`, `npm test`): pure logic next to the code, no DB/network.
  E2E specs (`test/**/*.e2e-spec.ts`, `npm run test:e2e`, alias `test:db`): real PostgreSQL in the
  `coins_test` database, migrated by the global setup (helpers refuse non-test DB names),
  including the schema-drift check. `test/live`: opt-in only (`RUN_LIVE_CMC_WEB=1`,
  `RUN_LIVE_SOURCE=1`) because they hit providers.
- Use saved fixtures (`test/fixtures/*`) and `FixtureCmcMarket`; mark samples as synthetic.
- Cover semantics, not just happy paths: rule boundaries (rank 100/101/1200/1201, cap exactly
  $15M, exactly 60 days, exactly 1.5×), gaps, stale data, nulls, duplicates, revisions, retries,
  permission boundaries, no look-ahead.
- Never weaken an assertion to make a test pass; fix the code or explain the behaviour.

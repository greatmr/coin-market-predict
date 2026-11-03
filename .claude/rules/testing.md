---
paths:
  - "test/**"
  - "vitest.config.ts"
---
# Testing

- `test/unit`: pure logic, no DB/network. `test/db`: real PostgreSQL in the `coins_test`
  database (helpers refuse non-test DB names). `test/live`: opt-in only
  (`RUN_LIVE_AGENT=1`, `RUN_LIVE_SOURCE=1`) because they spend usage or hit providers.
- Use saved fixtures (`test/fixtures/*.json`) and `FixtureMarket`; mark samples as synthetic.
- Cover semantics, not just happy paths: gaps, stale data, nulls, duplicates, retries,
  permission boundaries, no look-ahead.
- Never weaken an assertion to make a test pass; fix the code or explain the behaviour.

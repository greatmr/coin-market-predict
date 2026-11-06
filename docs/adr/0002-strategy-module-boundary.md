# ADR-0002 — The strategy is its own module

**Status:** Accepted, 2026-11-06 (operator request: separate the core business from the rest and
have the other modules use it).

## Context
The Two-Tier VMC rules — eligibility, VMC windows, pass/stars, queue order, LBank resolution,
venue summary, Tier 2 review and trade-plan rules, overrides — lived in `src/tier1/` next to
services that read and write the database, fetch daily rows and write exports. The rules are what
the operator audits against the strategy document; mixing them with I/O made them harder to find,
test and protect.

## Decision
`src/modules/strategy/` contains the strategy and nothing else:

| Part | Content |
|---|---|
| `strategy.constants.ts` | `RULESET_VERSION`, thresholds (`RULES`), reason codes, every status value set |
| `tier1/` | eligibility, VMC arithmetic, LBank resolution, venue summary, review-queue order (pure) |
| `tier2/` | Tier 2 review and manual trade-plan validation (pure) |
| `overrides/` | the versioned overrides file: schema, loading, configuration version |
| `StrategyService` | the rules bound to configuration (quote / LBank / venue age limits, overrides, `describe()`) |

- The rules are pure functions: no database, HTTP or Nest dependencies. The module imports only
  `common/utils` (exact decimals, dates), configuration types, Zod and Nest decorators.
- Its only entry point is `modules/strategy/index.ts`. ESLint (`no-restricted-imports`) rejects
  deep imports such as `../strategy/tier1/vmc.js` from outside the module.
- Every other module depends on the strategy, never the reverse: scan evaluates with it, venues
  and daily-metrics use its LBank and window rules, reviews validate with Tier 2 rules, entities
  take their enum values from its status sets, read-model / dashboard / Telegram / MCP display its
  outputs.
- Rule changes keep the existing discipline: bump `RULESET_VERSION`, update
  `docs/strategy-two-tier-vmc.md`, and cover the boundary cases in the module's specs.

## Consequences
- \+ One folder to audit against the strategy document; its specs run without a database.
- \+ A rule cannot quietly start doing I/O, and a consumer cannot reach into rule internals.
- − Anything a consumer needs must be exported from the barrel.
- − Status sets are shared with the database enums: a new status value fails the schema-drift test
  until a migration adds it to the enum type — intended, so stored values and rule outputs cannot
  diverge.

## Alternatives rejected
- **Rules inside the scan module**: hides the core business inside an I/O module that other
  modules would then have to import.
- **A separate package or workspace**: more build and release machinery than a single deployment
  needs; the lint rule gives the same boundary.

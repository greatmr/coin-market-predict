# Coins Predicts — development guide

Hourly crypto **screening for human review** (NestJS + TypeScript + PostgreSQL), implementing the
Two-Tier VMC strategy: a deterministic Tier 1 CoinMarketCap screen → a Tier 2 human chart review
with an optional manual LBank Spot trade plan. Output is a review queue — never trading advice,
never real orders. Spec: `docs/strategy-two-tier-vmc.md`. Purpose and open decisions: @intend.md

## Architecture boundaries
- One NestJS app (`src/main.ts`), CLI (`src/cli.ts`), MCP stdio entry (`src/mcp-stdio.ts`).
- Pipeline (`src/pipeline/pipeline.service.ts`): discover → collect (crawl batch, every listed
  coin) → lbank (LBank Spot pairs) → daily (completed UTC daily rows for screen candidates) →
  scan (Tier 1) → venues → export (CSV + XLSX) → notify (Telegram) → retention.
- Strategy rules live in `src/tier1/constants.ts` (`RULESET_VERSION`); pure logic in
  `tier1/eligibility.ts`, `tier1/vmc.ts`, `tier1/lbank.ts`, `tier1/venues.ts`, `tier1/queue.ts`,
  `tier1/review-rules.ts`. Any rule change bumps `RULESET_VERSION` and the strategy doc.
- **Deterministic code owns all numbers**: exact decimals (`common/decimal.ts`), no rounding before
  comparisons, no invented thresholds. Missing or ambiguous inputs → N/A or NEEDS_REVIEW with a
  reason code, never silently eligible.
- **PostgreSQL is the source of truth.** Dashboard reads `/api/*` (REST). MCP (`/mcp`, stdio)
  exposes read-only tools. Telegram reads from the DB via `ReportService`.
- Market data only via `MarketDataSource` / `Tier1Source` adapters (`src/sources/`). Default is
  the synthetic fixture (`FixtureCmcMarket`, ids ≥ 990001). The CMC website collector is the only
  live source with daily rows and LBank pairs (no website scraping beyond its JSON routes — see
  `docs/source-feasibility.md`).
- Reviews and LBank decisions are append-only; reviewer decisions never change stored source data.
- No LLM agents run in production (retired 2026-11-05; see `docs/architecture.md`).

## Commands
```bash
npm ci && cp .env.example .env        # first time
docker compose up -d postgres          # DB on 127.0.0.1:5433
npm run db:migrate                     # apply committed migrations
npm run build                          # prisma generate + tsc
npm run cli -- run-once                # one pipeline run (fixture source by default)
npm run cli -- tier1:trace --id 990001 # calculation trace for one coin
npm start                              # dashboard http://127.0.0.1:3000 + scheduler
npm test                               # unit tests (no DB, no network)
npm run test:db                        # DB tests (uses coins_test database)
npx prisma migrate dev --name <change> # schema changes (never `db push`); then `npx prisma generate`
```

## Rules of thumb
- Read `.claude/rules/` before editing the matching area; they are short.
- Never print, grep, or cat `.env` / `secrets/` values. Check secrets by name and length only.
- Tests use fixtures (`test/fixtures/`, `FixtureCmcMarket`); never hit live endpoints in `npm test`.
- Telegram may be live in `.env`: run verification pipelines with `TELEGRAM_MODE=dry_run`.
- Keep docs in `docs/` in sync when behaviour changes (strategy, architecture, source
  feasibility, operator guide).

# Coins Predicts — development guide

Hourly crypto **screening for human review** (NestJS + TypeORM + PostgreSQL), implementing the
Two-Tier VMC strategy: a deterministic Tier 1 CoinMarketCap screen → a Tier 2 human chart review
with an optional manual LBank Spot trade plan. Output is a review queue — never trading advice,
never real orders. Spec: `docs/strategy-two-tier-vmc.md`. Purpose and open decisions: @intend.md

## Architecture boundaries
- One NestJS app (`src/main.ts`), CLI (`src/cli.ts`), MCP stdio entry (`src/mcp-stdio.ts`), all
  composing `AppModule`. One module per area in `src/modules/<name>/` (`entities/`, `dto/`);
  shared code in `src/common/`, config in `src/config/`, TypeORM setup and migrations in
  `src/database/` (`docs/adr/0001-typeorm-modular-layout.md`).
- Pipeline (`src/modules/pipeline/pipeline.service.ts`): discover → collect (crawl batch, every
  listed coin) → lbank (LBank Spot pairs) → daily (completed UTC daily rows for screen
  candidates) → scan (Tier 1) → venues → export (CSV + XLSX) → notify (Telegram) → forward
  (Star Event Forward Test) → retention.
- **The strategy is its own module** (`src/modules/strategy/`, `docs/adr/0002-strategy-module-boundary.md`):
  `strategy.constants.ts` (`RULESET_VERSION`, thresholds, reason codes, status sets), pure
  `tier1/` (eligibility, vmc, lbank, venue-summary, review-queue), `tier2/review-rules.ts`,
  `overrides/`, and `StrategyService`. No I/O; other modules import it only via
  `modules/strategy/index.js` (ESLint-enforced). Any rule change bumps `RULESET_VERSION` and the
  strategy doc. The Review Queue order is the weighted star ranking (`tier1/review-queue.ts`,
  strategy doc § 6a): a weight / cap / sort-key change bumps `RANKING_RULESET_VERSION` instead and
  never rewrites stored scores.
- **Star Event Forward Test** (`src/modules/forward-test/`, `docs/forward-test.md`,
  `docs/adr/0004-forward-test-module.md`): an add-on that reads published Tier 1 results and never
  changes them. One event per (CMC id, UTC date, stars), first insert wins; the detection snapshot
  is immutable (DB trigger); Highs only from the same coin's CMC USD daily OHLC — never Close,
  sampled prices or LBank — and a signal-day High counts only with `time_high` ≥ detection.
  Pure rules in `forward-rules.ts` / `cohort.ts`; a rule change bumps `FORWARD_RULES_VERSION`
  (not `RULESET_VERSION`) and the doc. Reprocessing never creates events.
- **Deterministic code owns all numbers**: exact decimals (`common/utils/decimal.ts`), no rounding
  before comparisons, no invented thresholds. Missing or ambiguous inputs → N/A or NEEDS_REVIEW
  with a reason code, never silently eligible.
- **PostgreSQL is the source of truth.** snake_case tables, enum types, named constraints and
  foreign keys, created only by the raw-SQL migrations in `src/database/migrations/` (never
  `synchronize`). Dashboard reads `/api/*` (REST, `{ data, errors }` envelope). MCP (`/mcp`,
  stdio) exposes read-only tools. Telegram reads from the DB via `ReportService`.
- Market data only via `MarketDataSource` / `Tier1Source` adapters (`src/modules/sources/`).
  Default is the synthetic fixture (`FixtureCmcMarket`, ids ≥ 990001). The CMC website collector
  is the only live source with daily rows and LBank pairs (no website scraping beyond its JSON
  routes — see `docs/source-feasibility.md`).
- Reviews and LBank decisions are append-only; reviewer decisions never change stored source data.
- **Dashboard users** (`src/modules/auth/`, `docs/adr/0003-dashboard-users.md`): owner / analyzer /
  reviewer. Every `/api` route needs a session and the route's permission (`AuthGuard`, default
  `data:read`); give any new route that is not plain market data a `@RequirePermission(...)`. The
  role table is `modules/auth/permissions.ts`. Never weaken the last-active-owner rules in
  `UsersService`. An empty database gets `owner` / `owner` (must change) on server start.
- **The only LLM is the Claude coin agent** (`src/modules/agent/`, `docs/adr/0005-coin-agent.md`):
  it runs on an owner's request for one coin (`agent:use`), at most `AGENT_MAX_RUNS` (5) per
  rolling `AGENT_WINDOW_HOURS` (12), with read-only tools bound to that coin, and stores its view
  in `agent_analysis` (immutable once finished). It never feeds the pipeline, Tier 1 results,
  exports, Telegram or MCP. Auth is the subscription OAuth token only, via `buildAgentEnv()`.
- The live chart in the coin details is TradingView widgets in sandboxed cross-origin iframes
  (CSP `frame-src https://www.tradingview-widget.com`); never load third-party scripts into the
  dashboard.

## Commands
```bash
npm ci && cp .env.example .env         # first time
docker compose up -d postgres           # DB on 127.0.0.1:5433
npm run db:migrate                      # build + apply committed migrations (db:status lists them)
npm run cli -- run-once                 # one pipeline run (fixture source by default)
npm run cli -- tier1:trace --id 990001  # calculation trace for one coin
npm run cli -- forward:status           # forward test: star groups, coverage, warnings
npm start                               # dashboard http://127.0.0.1:3000 + scheduler (sign in: owner / owner first)
npm run cli -- users:reset-owner        # recover the owner sign-in (owner / owner, must change)
npm test                                # unit specs, src/**/*.spec.ts (no DB, no network)
npm run test:e2e                        # DB tests, test/**/*.e2e-spec.ts (coins_test; alias test:db)
npm run lint && npm run format:check    # ESLint (incl. strategy boundary) + Prettier
npm run migration:generate -- src/database/migrations/<Name>  # draft from entity changes; review, then register in migrations/index.ts
```

## Rules of thumb
- Read `.claude/rules/` before editing the matching area; they are short.
- Never print, grep, or cat `.env` / `secrets/` values. Check secrets by name and length only.
- Tests use fixtures (`test/fixtures/`, `FixtureCmcMarket`); never hit live endpoints in `npm test`.
- Telegram may be live in `.env`: run verification pipelines with `TELEGRAM_MODE=dry_run`.
- Keep docs in `docs/` in sync when behaviour changes (strategy, architecture, source
  feasibility, operator guide, ADRs in `docs/adr/`).

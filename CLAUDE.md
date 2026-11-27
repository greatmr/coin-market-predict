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
  candidates) → scan (Tier 1) → observe (LBank Spot Price Observation intake, right after the
  scan commit since 2026-11-27) → venues (review candidates' CMC Markets rows; LBank Futures and
  Bithumb lists, never Tier 1 inputs: `docs/adr/0007-exchange-listings.md`) → export (CSV)
  → notify (Telegram) → forward (legacy Star Event Forward Test) → retention.
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
  sampled prices or LBank — and a signal-day High counts only with `time_high` ≥ detection; the
  signal day after detection may come from the same series' hourly OHLC when its hours match the
  daily High (`forward_day0_capture`, rules `star-forward-2`).
  Pure rules in `forward-rules.ts` / `cohort.ts`; a rule change bumps `FORWARD_RULES_VERSION`
  (not `RULESET_VERSION`) and the doc. Reprocessing never creates events.
- **Star events and the cutover** (`src/modules/star-events/`, `docs/adr/0009-lbank-spot-observation.md`):
  the shared event rule (`validateTrigger`, `PublishedQueueService`; key (provider, CMC id, UTC date,
  stars), first insert wins) and `signal_cutover` (one UTC-midnight cutover per provider, set with
  `observation:cutover`, immutable once passed). Before it events go to the legacy forward test,
  at or after it to the LBank observation; database triggers refuse the wrong side. Never route
  by anything but the detection time.
- **LBank Spot Price Observation** (`src/modules/lbank-observation/`, `docs/lbank-spot-observation.md`,
  rules `lbank-spot-obs-2`, `docs/adr/0010-lbank-observation-v2.md`): its own tables
  (`lbank_obs_event`, `lbank_observation` with a unique event FK, shared `lbank_spot_candle`,
  `lbank_spot_trade` and `lbank_spot_trade_minute` per pair, day archives, append-only results and
  rules-change log), its own job and lease (`LBANK_OBSERVATION_CRON`), LBank's public REST API
  (`api.lbkex.com`, provider `lbank_spot`) or the synthetic fixture. Every price is an LBank Spot
  trade (the CMC price is context and a review flag only). The window is exactly
  `[observation_start, +168 h)` from the proven publication (`observation-timing.ts`: scan commit,
  never the crawl time, which only names the event); the reference is the first verified trade at
  or after the start; extremes are verified trades (candles only locate candidates: a candle OPEN is
  the previous close and High / Low can be it); `trades.do` returns trades strictly after `time`.
  No invented thresholds; gaps of every kind are retried until end + 24 h. Pure rules in
  `observation-rules.ts`; a rule change bumps `OBSERVATION_RULES_VERSION` and the doc, and rows move
  only through `lbank_obs_rules_change` (trigger). FINAL only with full verified coverage; the
  legacy tracker retires itself once every pre-cutover event has a terminal closure.
- **LBank Futures observed quote** (same module, `futures-quote-rules.ts`, `FuturesQuoteService`,
  `FuturesSamplerService`, docs § 13a, ADR-0011 addendum, rules `lbank-futures-quote-1`): one row per
  Spot observation (same start and end), its own contract (URL-pinned by CMC id, never by ticker). A
  `marketData` request fires the moment the Review Queue is published (not awaited); the reference is
  the first valid `lastPrice` from a request SENT at or after the start, timed by its RESPONSE (earliest
  receipt wins, DB-enforced) — an observed quote, never a trade time or a fill; turnover is context only.
  Every request attempt is logged with queue / send / receive / storage times. Older rows keep
  `lbank-futures-sampled-1` (turnover-bracket) with its label; never rewrite them. A rule change bumps
  `FUTURES_QUOTE_RULES_VERSION`; it never writes a Spot row.
- **Storage scope** (`docs/adr/0008-storage-scope.md`, D4): every coin is screened hourly and kept
  in the registry, but only ranks 1–1200 are stored as snapshots and only Review Queue rows as
  `scan_result`; other coins are counted on `scan_run.counts` and traced on request
  (`ScanService.evaluateCoins`, writes nothing). NEEDS_REVIEW fails closed (no windows or stars).
  Never prune queue rows, daily rows or forward-test data; earlier rows go only via `storage:prune`.
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
- **Dashboard** (`front/`, `docs/adr/0006-react-dashboard.md`): React 19 + strict TypeScript + Vite +
  React Router, its own package and container (`front/Dockerfile`: nginx serves the build and
  proxies `/api`, `/mcp`, `/healthz` to the `api` container). The NestJS app is API-only; another
  dashboard host needs `CORS_ORIGINS`. Pages are paths, list state is query params
  (`useQueryState`, `lib/routes.ts`), a coin is `/coins/:cmcId`. API calls only through
  `lib/api.ts` (cookie session, `apiUrl()` for links). Keep it CSP-clean (`front/nginx/`): no
  inline scripts or styles (React `style` props are fine), no `dangerouslySetInnerHTML`, charts as
  hand-drawn SVG, TradingView only as the sandboxed iframe. Shared pieces in
  `front/src/{lib,components,state,types}`, one folder per page in `front/src/features/`.
- **The only LLM is the Claude coin agent** (`src/modules/agent/`, `docs/adr/0005-coin-agent.md`):
  it runs on an owner's request for one coin (`agent:use`), at most `AGENT_MAX_RUNS` (5) per
  rolling `AGENT_WINDOW_HOURS` (12), with read-only tools bound to that coin, and stores its view
  in `agent_analysis` (immutable once finished). It never feeds the pipeline, Tier 1 results,
  exports, Telegram or MCP. Auth is the subscription OAuth token only, via `buildAgentEnv()`.
- **Claude chat** (`src/modules/agent/chat/`, `docs/adr/0012-owner-chat.md`): an owner-only,
  read-only conversation with the analyst desk (risk manager, pro trader, market data analyst). Its
  prompt is rebuilt from the strategy constants on every message, so it follows strategy updates;
  `CHAT_MAX_MESSAGES` (10) owner messages per conversation; model and effort chosen per message.
- The live chart in the coin details is TradingView widgets in sandboxed cross-origin iframes
  (CSP `frame-src https://www.tradingview-widget.com`); never load third-party scripts into the
  dashboard.

## Commands

```bash
npm ci && cp .env.example .env         # first time
docker compose up -d postgres           # DB on 127.0.0.1:5433
npm run db:migrate                      # build + apply committed migrations (db:status lists them)
npm run db:pull-prod                    # replace the local DB with production's (backs up local first), then migrate
npm run cli -- run-once                 # one pipeline run (fixture source by default)
npm run cli -- tier1:trace --id 990001  # calculation trace for one coin
npm run cli -- forward:status           # forward test: star groups, coverage, warnings
npm run cli -- observation:status       # LBank Spot observation: cutover, final-only stats, routing check
npm run cli -- observation:cutover      # show (or --at <future UTC midnight> set) the cutover
npm run cli -- storage:prune            # dry run of the one-time D4 cleanup (--apply [--vacuum] after a backup)
npm start                               # API http://127.0.0.1:3000 + scheduler (no pages)
npm run front:install && npm run front:dev  # dashboard http://127.0.0.1:5173, proxies /api to :3000 (sign in: owner / owner first)
npm run front:typecheck && npm run front:build  # strict TS check; production bundle (front/dist)
docker compose --profile app up -d --build  # api :3000 + web :8080 in containers
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

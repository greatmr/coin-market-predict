# Coins Predicts — development guide

Hourly crypto monitoring and **signal research** system (NestJS + TypeScript + PostgreSQL +
Claude Agent SDK). Output is research hypotheses for paper trading — never trading advice,
never real orders. Purpose, requirements and open decisions: @intend.md

## Architecture boundaries
- One NestJS app (`src/main.ts`), CLI (`src/cli.ts`), MCP stdio entry (`src/mcp-stdio.ts`).
- Pipeline (`src/pipeline/pipeline.service.ts`): discover → collect → validate → persist →
  features → screen → analyze (agents) → persist signals → publish → Telegram.
- **Deterministic code owns all numbers**: ingestion, features, screening, scenarios,
  paper trading, backtests. Agents interpret evidence; they never compute or invent numbers.
- **PostgreSQL is the source of truth.** Dashboard reads `/api/*` (REST). MCP (`/mcp`, stdio)
  exposes scoped tools to agents/hosts. Telegram reads from the DB via `ReportService`.
- Market data only via `MarketDataSource` adapters (`src/sources/`). Default is the
  synthetic fixture source. Live adapters are optional official APIs (no website scraping —
  see `docs/source-feasibility.md`).
- Agents: 1 coordinator + 2 specialists (`src/agents/`). Model ids come only from config.
- Volume / Market Cap baseline (`src/vmc/`, `docs/volume-mcap.md`): CMC-id-keyed daily history →
  six-month mean of daily ratios; hourly rolling-24h snapshots; descriptive comparison only (no
  signals). Independent of the signal pipeline; daily and hourly tables are never mixed.

## Instructions: development vs production runtime
| Applies to | Files | Loaded by |
|---|---|---|
| Development sessions (you) | `CLAUDE.md`, `intend.md`, `.claude/rules/*.md`, `.claude/skills/*` | Claude Code automatically |
| Production agents | `runtime/agents/*.md`, `runtime/plugin/skills/*` | `src/agents/roles.ts` + `claude-runner.ts` **explicitly** (`settingSources: []`, plugin path, `skills` list) |

Production agents never see this file or `.claude/`. Edit `runtime/` to change agent behaviour.

## Commands
```bash
npm ci && cp .env.example .env        # first time
docker compose up -d postgres          # DB on 127.0.0.1:5433
npm run db:migrate                     # apply committed migrations
npm run build                          # prisma generate + tsc
npm run cli -- seed-fixtures --hours 48   # synthetic history (fixture source only)
npm run cli -- run-once                # one pipeline run
npm start                              # dashboard http://127.0.0.1:3000 + scheduler
npm test                               # unit tests (no DB, no network)
npm run test:db                        # DB tests (uses coins_test database)
RUN_LIVE_AGENT=1 npm run test:live     # optional, spends Claude usage
npx prisma migrate dev --name <change> # schema changes (never `db push`); then `npx prisma generate`
VMC_ASSET_IDS=1,1027,2 npm run cli -- vmc:run-all   # volume/mcap workflow (fixture by default)
VMC_ASSET_IDS=1,1027,2 npm run cli -- vmc:compare
```

## Rules of thumb
- Read `.claude/rules/` before editing the matching area; they are short.
- Never print, grep, or cat `.env` / `secrets/` values. Check secrets by name and length only.
- Tests use fixtures (`test/fixtures/`, `FixtureMarket`); never hit live endpoints in `npm test`.
- Keep docs in `docs/` in sync when behaviour changes (architecture, source feasibility,
  strategy limitations).

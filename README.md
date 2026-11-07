# Coins Predicts

Hourly cryptocurrency **screening for human review**, implementing the Two-Tier VMC strategy:

- **Tier 1 (automated, deterministic):** every hour, collect the CoinMarketCap listing, keep
  coins ranked 101–1200 with circulating market cap ≥ $15M, listed ≥ 60 days, not stablecoins
  or tokenized assets, and tradable on LBank Spot; compare each coin's current rolling-24h
  volume / market cap (VMC) with the mean of its own completed daily VMC over the last 3, 7 and
  30 UTC days. A coin enters the **Review Queue** when the current VMC is at least 1.5× at least
  one of those means.
- **Tier 2 (human):** review each queued coin's venues and 1D chart, and optionally record a
  manual LBank Spot trade plan. The system validates and stores the record; it never trades.

> Research screening only. The Review Queue is not a buy list or a prediction; stars count met
> windows and are not probabilities. No orders are ever placed. Hourly data cannot see intrahour
> moves.

- Strategy specification (with PDF page references, assumptions, conflicts): [docs/strategy-two-tier-vmc.md](docs/strategy-two-tier-vmc.md)
- Operating it day to day: [docs/operator-guide.md](docs/operator-guide.md)
- Architecture: [docs/architecture.md](docs/architecture.md); decisions: [TypeORM and the module layout](docs/adr/0001-typeorm-modular-layout.md), [the strategy module](docs/adr/0002-strategy-module-boundary.md)
- Data sources and the website collector: [docs/source-feasibility.md](docs/source-feasibility.md)
- Field mapping and data gaps: [docs/tier1-input-mapping.md](docs/tier1-input-mapping.md)
- Implementation plan, database preparation and recovery: [docs/implementation-plan.md](docs/implementation-plan.md)
- Purpose, requirements, open decisions: [intend.md](intend.md)

## What is live vs synthetic
| Component | Status |
|---|---|
| Market data | **Synthetic fixture by default** (labelled SYNTHETIC everywhere). Live: CMC website collector (no key) — the only live source with daily history and LBank pairs |
| LBank pairs | From the Markets section of CMC's LBank exchange page, fetched once and refreshed every 30 days or on demand (dashboard button / `lbank:refresh`). A listed pair counts as tradable unless a reviewer marks it otherwise; no trading status is available from any source used |
| Telegram | Dry-run by default; live with `TELEGRAM_MODE=live` + bot token + chat id |
| Dashboard / MCP / PostgreSQL | Live (local) |

## Requirements
Node.js ≥ 22.12 (Docker image uses Node 24 LTS), Docker with Compose v2, npm 10+.

## Code layout
NestJS + TypeORM + PostgreSQL, native ESM. One module per area in `src/modules/` (sources,
ingestion, daily-metrics, venues, scan, exports, reviews, pipeline, telegram, read-model,
dashboard, mcp, app-state); the Two-Tier VMC rules are their own pure module,
`src/modules/strategy`. Shared code is in `src/common`, configuration in `src/config`, the
TypeORM setup and raw-SQL migrations in `src/database`. Details:
[docs/architecture.md](docs/architecture.md#modules-src).

## Setup
```bash
npm ci
cp .env.example .env              # then edit; never commit .env
docker compose up -d postgres     # PostgreSQL 17 on 127.0.0.1:5433, volume coins_pgdata
npm run db:migrate                # builds, then applies the committed TypeORM migrations
npm run cli -- config:check       # validates config; secrets shown as <set>/<not set>
```
A database created before 2026-11-06 still has the old Prisma tables: follow the one-time
cut-over in [operator-guide § 9](docs/operator-guide.md#9-backup-restore-and-migrations) instead
of only running `db:migrate`.

## Run
```bash
npm run cli -- run-once           # one batch for the current UTC hour
npm start                         # dashboard http://127.0.0.1:3000 + hourly scheduler
npm run dev                       # watch mode
```
The scheduler runs `PIPELINE_CRON` (default minute 7 of every hour, UTC) and retries Telegram
every 5 minutes. On startup it records missed hours and runs the current hour if needed.
One run: discover → collect (crawl batch) → LBank pairs → daily rows → scan → venue rows →
export (CSV + XLSX) → Telegram. Details: [docs/architecture.md](docs/architecture.md#pipeline-stages).

CLI (`npm run cli -- help`): `run-once`, `discover`, `tier1:scan`, `tier1:export`,
`tier1:trace --id <cmcId>`, `tier1:batches`, `lbank:status`, `lbank:refresh`,
`daily:import-csv`, `telegram:preview`, `telegram:test`, `telegram:deliver`, `source:reset`.

### Live data (CMC website collector, no key)
```dotenv
DATA_SOURCE=coinmarketcap_web
CMC_WEB_MONTHLY_REQUEST_BUDGET=30000
```
The first live run fetches 35 completed days per screen candidate (about one request each at
30 requests/minute), spread over the first two or three runs; windows stay N/A until their days
arrive. The website routes are not a supported API and may change or block access; see
[docs/source-feasibility.md](docs/source-feasibility.md). The official CMC / CoinGecko keyed
adapters (`DATA_SOURCE=coinmarketcap|coingecko`) supply listings only, so every window is N/A.

### Telegram
Create a bot with @BotFather, then set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and
`TELEGRAM_MODE=live`. Each batch sends one compact summary: the batch time, counts, and a two-line card per
Review Queue coin (stars, current VMC, 3d / 7d / 30d multiples with YES in bold). Tap a coin name and the bot replies with that
coin's details (a `t.me/<bot>?start=coin_<id>` link; before the bot has looked up its own
username the card shows `/coin_<id>` instead). A withheld or empty queue says why. The batch's Excel workbook (all five sheets, ~2 MB)
follows as a file unless the queue is withheld (`TELEGRAM_ATTACH_EXPORT=none` turns this off).
Preview first:
```bash
npm run cli -- telegram:preview --fake   # layout with invented numbers
npm run cli -- telegram:preview          # latest stored batch
```
Bot commands for members: `/report`, `/status`, `/vmc <CMC id or symbol>` (windows) and
`/coin <CMC id or symbol>` (one coin in a single message: windows with bars, VMC and price
sparklines, LBank, venues, review, and the daily rows in a collapsed quote). Access control (owner
approves members) is described in [docs/architecture.md](docs/architecture.md#telegram).

## MCP
- HTTP: `POST http://127.0.0.1:3000/mcp` with `Authorization: Bearer <MCP_READ_TOKEN>`
  (generate with `openssl rand -hex 24`).
- stdio (local hosts): `npm run mcp:stdio`. `.mcp.json` registers it for Claude Code in this
  repo through `scripts/mcp-stdio.sh`, which selects the `.nvmrc` Node version via nvm.
- Read-only tools: `get_scan_summary`, `get_scan_results`, `get_asset_trace`, `list_batches`,
  `get_mapping_tasks`, `get_coverage`, `get_snapshots`, `list_assets`, `get_run_status`.
  Resources: `coins://tier1/queue/latest`, `coins://runs/latest`.

## Tests
```bash
npm test                        # unit specs next to the code (offline): rules, boundaries, decimal math, parsers, writers
npm run test:e2e                # PostgreSQL tests in database coins_test (auto-created + migrated; alias test:db)
npm run typecheck
npm run lint                    # ESLint, including the strategy-module import boundary
npm run format:check            # Prettier
npm run lint:secrets            # scans files that would be committed
RUN_LIVE_CMC_WEB=1 npm run test:live  # public CMC listing/history/pair routes, no key
RUN_LIVE_SOURCE=1 npm run test:live   # one page from CMC/CoinGecko APIs if keys are set
```

## Docker
```bash
# Database only (host-based NestJS): see Setup.
# Full stack in containers (the app binds 0.0.0.0; every page needs a sign-in):
mkdir -p secrets && touch secrets/telegram_bot_token
docker compose --profile app up -d --build
```
Secrets reach the container at runtime via `env_file` or mounted secret files; `.dockerignore`
keeps `.env` and `secrets/` out of the build context. Exports persist in the `coins_app_var`
volume.

## Database operations
- Migrations: `npm run db:migrate` (apply), `npm run db:status` (applied / pending). To change
  the schema, edit the entities, draft a migration with
  `npm run migration:generate -- src/database/migrations/<Name>` (or `migration:create` for an
  empty one), review the SQL, and register it in `src/database/migrations/index.ts`; the schema
  drift test checks that entities and migrations agree. Never `synchronize`, `schema:sync` or
  `schema:drop`; `db:revert` only on development databases.
- Retention: `RETENTION_DETAIL_DAYS=30` (default) keeps 30 days of hourly detail for every coin,
  then thins coins outside the Tier 1 band to one snapshot per UTC day; see
  [Storage and retention](docs/architecture.md#storage-and-retention). Reviews, decisions, daily
  rows and batches are never pruned.
- Backup: `docker compose exec -T postgres pg_dump -U coins -Fc coins > backups/coins-$(date +%F).dump`
- Restore (into an empty DB): `docker compose exec -T postgres pg_restore -U coins -d coins --clean --if-exists < backups/coins-YYYY-MM-DD.dump`
- History survives container restarts in the named volume `coins_pgdata`. Do not run
  `docker compose down -v` unless you intend to delete all history.

## Costs
Market data $0 (fixture / website collector / free tiers). No model inference. Telegram is
free. Hosting: your machine or a small VM.

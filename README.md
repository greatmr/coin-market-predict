# Coins Predicts

Hourly cryptocurrency monitoring and **signal research**. Collects market snapshots, keeps
history in PostgreSQL, computes features, screens every eligible token with deterministic code,
reviews a small shortlist with Claude Agent SDK agents, and publishes to a dashboard, an MCP
server, and a Telegram channel.

> Research hypotheses only. Not financial advice. No orders are ever placed. Hourly snapshots
> cannot observe intrahour moves. Scores are heuristics, not probabilities.

- Purpose, requirements, open decisions: [intend.md](intend.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Data sources and why there is no scraper: [docs/source-feasibility.md](docs/source-feasibility.md)
- Strategy, features and limitations: [docs/strategy-limitations.md](docs/strategy-limitations.md)

## What is live vs fixture
| Component | Status |
|---|---|
| Market data | **Fixture (synthetic) by default.** Optional official free APIs: CoinMarketCap Basic, CoinGecko Demo (need your key; not yet exercised live) |
| Claude agents | Real Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN` (`AGENT_PROVIDER=claude`); offline `fixture` stand-in by default |
| Telegram | Dry-run by default; live with `TELEGRAM_MODE=live` + bot token + chat id |
| Dashboard / MCP / PostgreSQL | Live (local) |

## Requirements
Node.js ≥ 22.12 (Docker image uses Node 24 LTS), Docker with Compose v2, npm 10+.

## Setup
```bash
npm ci
cp .env.example .env              # then edit; never commit .env
docker compose up -d postgres     # PostgreSQL 17 on 127.0.0.1:5433, volume coins_pgdata
npm run db:migrate                # prisma migrate deploy
npm run build
npm run cli -- config:check       # validates config; secrets shown as <set>/<not set>
```

### Claude authentication
1. `claude setup-token` (Claude Pro/Max/Team/Enterprise subscription) → copy the token.
2. Put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=…` **or** in `secrets/claude_code_oauth_token`
   and set `CLAUDE_CODE_OAUTH_TOKEN_FILE=./secrets/claude_code_oauth_token`.
3. Set `AGENT_PROVIDER=claude`. Check with `npm run cli -- agent:check` (no model call).

The token is passed only to the Agent SDK subprocess through an allowlisted environment;
`ANTHROPIC_API_KEY` is never forwarded, so there is no silent fallback to API-key billing.
The token lasts about a year and is not refreshed by this app; on `authentication_failed`
regenerate it. Anthropic does not allow offering claude.ai login/limits to third parties
without approval — keep this deployment for your own use.

### Telegram
Create a bot with @BotFather, add it as an admin of your channel, then set
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (e.g. `@your_channel` or `-100…`) and
`TELEGRAM_MODE=live`. Preview first:
```bash
npm run cli -- telegram:preview --fake   # layout with invented numbers
npm run cli -- telegram:preview          # latest stored run
```

## Run
```bash
npm run cli -- seed-fixtures --hours 48  # optional synthetic history (fixture source only)
npm run cli -- run-once                  # one pipeline run for the current hour
npm start                                # dashboard http://127.0.0.1:3000 + hourly scheduler
npm run dev                              # watch mode
```
CLI: `npm run cli -- help` (discover, run-once, seed-fixtures, telegram:preview,
telegram:deliver, backtest, source:reset, agent:check).

The scheduler runs `PIPELINE_CRON` (default minute 7 of every hour, UTC) and retries Telegram
every 5 minutes. On startup it records missed hours and runs the current hour if needed.

### Live market data (optional, read docs/source-feasibility.md first)
```bash
# CoinMarketCap Basic: free key from https://coinmarketcap.com/api/
DATA_SOURCE=coinmarketcap  CMC_API_KEY=…
# or CoinGecko Demo: free key from https://www.coingecko.com/en/api
DATA_SOURCE=coingecko      COINGECKO_API_KEY=…
npm run cli -- discover && npm run cli -- run-once
```
Live sources start in warm-up: real history accumulates one snapshot per hour (no invented
backfill). Coverage is partial by design on free tiers and labelled as such.

## MCP
- HTTP: `POST http://127.0.0.1:3000/mcp` with `Authorization: Bearer <MCP_READ_TOKEN|MCP_WRITE_TOKEN>`
  (generate with `openssl rand -hex 24`).
- stdio (local hosts, read-only): `npm run mcp:stdio` (`--allow-write` to add
  `publish_signal_report`). `.mcp.json` registers it for Claude Code in this repo.
- Tools: `list_assets`, `get_coverage`, `get_snapshots`, `get_features`, `get_signals`,
  `get_run_status`, write: `publish_signal_report`. Resources: `coins://signals/latest`,
  `coins://runs/latest`.

## Tests
```bash
npm test                        # unit (offline)
npm run test:db                 # PostgreSQL tests in database coins_test (auto-created + migrated)
npm run typecheck
npm run lint:secrets            # scans files that would be committed
RUN_LIVE_AGENT=1 npm run test:live    # real Claude call (spends usage)
RUN_LIVE_SOURCE=1 npm run test:live   # one page from CMC/CoinGecko if keys are set
```

## Docker
```bash
# Database only (host-based NestJS): see Setup.
# Full stack in containers (needs DASHBOARD_BASIC_AUTH in .env because the app binds 0.0.0.0):
mkdir -p secrets && touch secrets/claude_code_oauth_token secrets/telegram_bot_token
docker compose --profile app up -d --build
```
Secrets reach the container at runtime via `env_file` or mounted secret files; `.dockerignore`
keeps `.env` and `secrets/` out of the build context. The image contains `runtime/` (agent
instructions and skills) so production agents load the same procedures.

## Database operations
- Migrations: `npm run db:migrate` (deploy), `npx prisma migrate dev --name <change>` (author).
  Never `db push`/`migrate reset` against real history.
- Retention: `RETENTION_SNAPSHOT_DAYS=0` keeps everything (default, for research). A positive
  value deletes snapshots/features older than N days after each run.
- Backup: `docker compose exec -T postgres pg_dump -U coins -Fc coins > backups/coins-$(date +%F).dump`
- Restore (into an empty DB): `docker compose exec -T postgres pg_restore -U coins -d coins --clean --if-exists < backups/coins-YYYY-MM-DD.dump`
- History survives container restarts in the named volume `coins_pgdata`. Do not run
  `docker compose down -v` unless you intend to delete all history.

## Costs
Market data $0 (fixture / free tiers). Claude usage counts against your subscription; the run
and daily caps (`AGENT_RUN_BUDGET_USD`, `AGENT_DAILY_BUDGET_USD`) use the SDK's cost estimate.
Telegram is free. Hosting: your machine or a small VM.

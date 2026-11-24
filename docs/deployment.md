# Deployment (manual, Docker on the shared server)

Production runs at **https://predict.jahantalab.com** on `65.109.178.236` (`ssh jahantalab`).
Deploys are manual: update the code on the server, rebuild, restart. There is no CI/CD pipeline.

## Environment (checked 2026-11-10)

| Item | Value |
|---|---|
| Project path on server | `/root/jahan/market-predict` (git clone) |
| Compose file | `deploy/docker-compose.prod.yml` (project `coins-predicts-prod`) |
| Config file (not in git) | `/root/jahan/market-predict/.env.prod` |
| Containers | `web` (dashboard, nginx) on `127.0.0.1:38417` → `8080` (`APP_PORT` to change); `api` (NestJS) on the private network only; `postgres` |
| Request path | host Nginx → `web` → (`/api`, `/mcp`, `/healthz`) `api`; pages from `web` ([ADR-0006](adr/0006-react-dashboard.md)) |
| Nginx | host Nginx; vhost `/etc/nginx/sites-available/predict.jahantalab.com`, TLS by certbot |
| Volumes | `coins-predicts-prod_pgdata` (database), `coins-predicts-prod_app_var` (exports) |

Other stacks on the server: `dimension-*` (host ports 2354, 2355), `extraction-engine` (its vhost
proxies to 3000 and 8000), `maple`, `services`. Host ports in use: 22, 80, 443, 631, 2354, 2355.
This stack avoids all of them: unique project name, private Docker network, Postgres not
published, existing vhosts never edited.

Shorthand used below:
```bash
cd /root/jahan/market-predict
alias dc='docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod'
```

## First deploy

1. **Code**: clone or copy the repo to `/root/jahan/market-predict`.
2. **Config**: create `.env.prod` (never commit; it is ignored by `.env.*`):
   ```bash
   DBPW=$(openssl rand -hex 24); DASHPW=$(openssl rand -hex 16)
   cat > .env.prod <<EOF
   POSTGRES_PASSWORD=$DBPW
   DASHBOARD_BASIC_AUTH=admin:$DASHPW
   DATA_SOURCE=fixture
   TELEGRAM_MODE=dry_run
   EOF
   chmod 600 .env.prod
   echo "Dashboard login -> admin / $DASHPW"     # save it; shown once
   ```
   `DASHBOARD_BASIC_AUTH` is required: the app binds `0.0.0.0` inside the container and the site
   is public. Other settings and their defaults: `.env.example`.
3. **Start**:
   ```bash
   dc up -d --build
   dc ps
   curl -fsS http://127.0.0.1:38417/healthz
   ```
   Migrations run on container start (`RUN_MIGRATIONS=true`). This builds two images: the API
   (repo root) and the dashboard (`front/`, served by nginx); nothing else is needed on the host.
   `/healthz` on port 38417 goes through the dashboard container to the API, so it checks both.
4. **Nginx**:
   ```bash
   cp deploy/nginx/predict.jahantalab.com.conf /etc/nginx/sites-available/predict.jahantalab.com
   ln -s /etc/nginx/sites-available/predict.jahantalab.com /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   ```
5. **DNS and HTTPS**: Cloudflare `A` record `predict` → `65.109.178.236`, then
   ```bash
   certbot --nginx -d predict.jahantalab.com     # choose the redirect option
   ```
   This is needed because the server's port-443 default server returns 444 for unknown hosts.
   If certbot fails while Cloudflare proxies the record, set it to "DNS only", rerun, then turn
   the proxy back on with SSL mode "Full (strict)".
6. **Smoke test**: open the site and sign in as `admin`; optionally run one pipeline now:
   ```bash
   dc exec api node dist/cli.js run-once
   ```
   The scheduler also runs at minute 7 of every hour (UTC).

## Update
```bash
cd /root/jahan/market-predict && git pull
dc up -d --build --remove-orphans
```
`--remove-orphans` matters once, on the first update to the two-container layout (2026-11-15): it
removes the old single `app` container, which otherwise keeps port 38417 and stops `web` from
starting. The exports volume (`app_var`) is reused by `api`.
Data survives: it lives in the named volumes. When the update brings a new migration (for example
M008, the Star Event Forward Test), take the backup below first: the app applies migrations at
container start. Check with `dc exec api node dist/cli.js db:status`; forward-test commands are in
[forward-test.md § 12](forward-test.md#12-runbook).

**Storage scope (D4, 2026-11-24, [ADR-0008](adr/0008-storage-scope.md)).** That update (migration
M014) stops storing per-coin rows outside the Review Queue and snapshots ranked above 1200; it
deletes nothing. Remove the earlier rows once, by hand, right after an hourly run has finished
(minute ~15; the command holds the pipeline lease, so a run starting meanwhile is skipped):
```bash
dc exec -T postgres pg_dump -U coins -Fc -t scan_result -t market_snapshot -t crawl_batch \
  -t scan_run -t app_state coins > ~/coins-pre-prune-$(date +%F).dump   # backup first
dc exec api node dist/cli.js storage:prune                    # dry run: counts only
dc exec api node dist/cli.js storage:prune --apply --vacuum   # delete, then return the space
```
Until it has run, hourly retention deletes no snapshot (`legacyPending` in the run's retention
metrics). `RETENTION_DETAIL_DAYS` (default 7) is the hourly window kept afterwards; check whether
`.env.prod` sets it (by name only): an explicit 30 keeps about four times the snapshots.

## API on its own subdomain (optional)
By default the dashboard and the API share `https://predict.jahantalab.com` (`web` proxies `/api`).
To serve the API at `https://api-predict.jahantalab.com` instead (same site, so the session cookie
still works):
1. Add to `.env.prod`: `DASHBOARD_ORIGIN=https://predict.jahantalab.com` and
   `API_ORIGIN=https://api-predict.jahantalab.com`.
2. Start with the override:
   `docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.api-subdomain.yml --env-file .env.prod up -d --build`
   (it publishes the API on `127.0.0.1:38418`, sets `CORS_ORIGINS` on `api`, and `API_BASE_URL`
   and `CSP_CONNECT_SRC` on `web`).
3. DNS `api-predict` → the server, then install `deploy/nginx/api-predict.jahantalab.com.conf` and
   run `certbot --nginx -d api-predict.jahantalab.com`.
MCP clients then use `https://api-predict.jahantalab.com/mcp`. Without these steps nothing changes.

## Configuration notes
- Edit `.env.prod`, then `dc up -d` (recreates the app with the new values).
- **`TELEGRAM_MODE=live` needs both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`**, otherwise the app
  refuses to start. Use `dry_run` until credentials are set. Edit the file on the server; do not
  paste tokens into chat or commit them.
- `DATA_SOURCE=coinmarketcap_web` is the only live source with daily rows and LBank pairs
  (see `docs/source-feasibility.md`). `fixture` is synthetic data.
- **Claude coin agent** (owners only, [ADR-0005](adr/0005-coin-agent.md)): add
  `CLAUDE_CODE_OAUTH_TOKEN=<token from claude setup-token>` to `.env.prod` on the server, then
  `dc up -d`. Without it the Agent tab says the agent is not configured; an API key is refused at
  start. The update that adds it brings migration M010 (take the backup first) and makes the image
  about 330 MB larger (the Agent SDK's native CLI). The agent keeps its process state under
  `/app/var/agent` in the `app_var` volume.
- Check config by key name and length only: `awk -F= '/^[A-Z_]+=/{print $1, length($2)}' .env.prod`.

## Operations
```bash
dc ps                              # status / health
dc logs -f --tail 100 api          # API logs (web: dc logs web)
dc restart api web
dc down                            # stop (keeps data)
```
**Never run `dc down -v`**: it deletes the database volume.

Copy the production data to a local machine: `npm run db:pull-prod` there (needs `ssh jahantalab`;
`docs/operator-guide.md` § 9).

Database backup (restore steps: `docs/operator-guide.md`):
```bash
dc exec -T postgres pg_dump -U coins coins | gzip > ~/coins-$(date +%F).sql.gz
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `exec` says "container is restarting" | Crash loop: read `dc logs --tail 40 api`. |
| Log: `Invalid configuration: TELEGRAM_MODE=live requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID` | Add both to `.env.prod`, or set `TELEGRAM_MODE=dry_run`; then `dc up -d`. |
| `.env.prod` / `POSTGRES_PASSWORD` error from compose | File missing or the variable is empty. |
| `port is already allocated` on 38417 | Another service took it: set `APP_PORT=<free port>` in `.env.prod` and the same port in the Nginx `proxy_pass`. |
| Site returns nothing / connection closed | Vhost not enabled, or the host is not matched (the default server returns 444): check `sites-enabled` and the DNS record. |
| 502 from Nginx | `web` not running: `dc ps`, `curl http://127.0.0.1:38417/web-healthz`. |
| Dashboard loads, every request fails / "API unreachable" | `api` not healthy: `dc logs --tail 40 api`; `curl http://127.0.0.1:38417/healthz` (through `web`). |
| `port is already allocated` on 38417 right after updating | The old single `app` container still holds it: `dc up -d --remove-orphans`. |
| Password change for Postgres has no effect | The password is only applied when the volume is first created. Change it inside Postgres with `ALTER USER`, then update `.env.prod`. |

# Deployment (manual, Docker on the shared server)

Production runs at **https://predict.jahantalab.com** on `65.109.178.236` (`ssh jahantalab`).
Deploys are manual: update the code on the server, rebuild, restart. There is no CI/CD pipeline.

## Environment (checked 2026-11-10)

| Item | Value |
|---|---|
| Project path on server | `/root/jahan/market-predict` (git clone) |
| Compose file | `deploy/docker-compose.prod.yml` (project `coins-predicts-prod`) |
| Config file (not in git) | `/root/jahan/market-predict/.env.prod` |
| App port | `127.0.0.1:38417` → container `3000` (`APP_PORT` to change) |
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
2. **Config**: create `.env.prod` (never commit; it is ignored by `.env.*`). It holds only what
   the dashboard does not manage: the database password, credentials and, if needed, the proxy /
   cookie set-up and file paths (see `.env.example`). `NODE_ENV`, `HOST`, `PORT` and
   `DATABASE_URL` come from the compose file.
   ```bash
   DBPW=$(openssl rand -hex 24); OWNERPW=$(openssl rand -hex 12)
   cat > .env.prod <<EOF
   POSTGRES_PASSWORD=$DBPW
   INITIAL_OWNER_PASSWORD=$OWNERPW
   EOF
   chmod 600 .env.prod
   echo "First sign-in -> owner / $OWNERPW"     # save it; shown once, changed at first sign-in
   ```
   Add `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` and `MCP_READ_TOKEN` / `MCP_WRITE_TOKEN`
   (`openssl rand -hex 24`) when you use them. Everything else (data source, schedule, Telegram
   mode, budgets, retention) is set after the first sign-in under **Settings**.
3. **Start**:
   ```bash
   dc up -d --build
   dc ps
   curl -fsS http://127.0.0.1:38417/healthz
   ```
   Migrations run on container start (`RUN_MIGRATIONS=true`).
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
6. **Settings and smoke test**: open the site, sign in as `owner` and choose your own password.
   Under **Settings** pick the data source (`coinmarketcap_web` for live data: restart the app
   afterwards, `dc restart app`) and keep Telegram on `dry_run` until the output looks right.
   Optionally run one pipeline now:
   ```bash
   dc exec app node dist/cli.js run-once
   ```
   The scheduler also runs at minute 7 of every hour (UTC).

## Update
```bash
cd /root/jahan/market-predict && git pull
dc up -d --build
```
Data survives: it lives in the named volumes. When the update brings a new migration (for example
M008, the Star Event Forward Test), take the backup below first: the app applies migrations at
container start. Check with `dc exec app node dist/cli.js db:status`; forward-test commands are in
[forward-test.md § 12](forward-test.md#12-runbook).

## Configuration notes
- **Operational settings** (data source, schedule, budgets, Tier 1 bounds, LBank cadence,
  retention, Telegram mode, time zone, session length, MCP over HTTP) are managed by the owner in
  the dashboard under **Settings** ([ADR-0005](adr/0005-dashboard-settings.md)). Most apply at once
  (after a pipeline run in progress); the data source, the listing page size and the pages per run
  apply after `dc restart app`. From the shell: `dc exec app node dist/cli.js settings:list`
  (`settings:set KEY VALUE`, `settings:reset KEY`, `settings:history`).
- **`.env.prod`** keeps the database password, credentials and the proxy / cookie / file-path
  variables. Edit it, then `dc up -d` (recreates the app with the new values). A setting variable
  left in it takes precedence and is shown locked in the dashboard.
- **Live Telegram needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`** in `.env.prod`; the dashboard
  refuses `live` without them. Edit the file on the server; do not paste tokens into chat or commit
  them.
- `coinmarketcap_web` is the only live data source with daily rows and LBank pairs
  (see `docs/source-feasibility.md`). `fixture` is synthetic data.
- Check config by key name and length only: `awk -F= '/^[A-Z_]+=/{print $1, length($2)}' .env.prod`.

## Moving settings from `.env.prod` to the dashboard (one time, from M010)
After the update that adds dashboard settings, every variable still in `.env.prod` keeps
precedence, so nothing changes until you move them:
```bash
cd /root/jahan/market-predict
cp -p .env.prod ".env.prod.bak-$(date +%F)"               # keep the old file (chmod 600 copy)
git pull && dc up -d --build                                # applies M010 at start
dc exec app node dist/cli.js settings:import-env --dry-run  # what would be copied
dc exec app node dist/cli.js settings:import-env            # or Settings → Import from environment
```
The import prints the variables to remove. Delete those lines from `.env.prod` (also the
`NODE_ENV`, `HOST`, `DATABASE_URL` lines, which the compose file sets anyway, and any
`DASHBOARD_BASIC_AUTH`, which nothing reads), then:
```bash
dc up -d                                                    # recreate with the trimmed file
dc exec app node dist/cli.js settings:list                  # every moved key: source "dashboard"
```
Do not delete a setting line without importing it first: the default would apply (for example
`DATA_SOURCE` falls back to the synthetic fixture).

## Operations
```bash
dc ps                              # status / health
dc logs -f --tail 100 app          # app logs
dc restart app
dc down                            # stop (keeps data)
```
**Never run `dc down -v`**: it deletes the database volume.

Database backup (restore steps: `docs/operator-guide.md`):
```bash
dc exec -T postgres pg_dump -U coins coins | gzip > ~/coins-$(date +%F).sql.gz
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `exec` says "container is restarting" | Crash loop: read `dc logs --tail 40 app`. |
| Log: `Invalid configuration: TELEGRAM_MODE=live requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID` | Add both to `.env.prod` and `dc up -d`; or, when the log says the value is saved in the dashboard settings, `dc run --rm app node dist/cli.js settings:set TELEGRAM_MODE dry_run`. |
| Log: `… (saved in the dashboard settings: …)` | A saved setting no longer fits the environment. Fix it from the shell (the app need not run): `dc run --rm app node dist/cli.js settings:reset KEY`, or pin the key in `.env.prod`. |
| Log: `Could not read the dashboard settings from the database` | Postgres is not reachable: `dc ps`, `dc logs --tail 40 postgres`. The app does not start on the environment alone, so it never silently runs other settings. |
| A setting is greyed out in the dashboard | It is set in `.env.prod`, which takes precedence. Import it (Settings → Import from environment), remove the line, `dc up -d`. |
| `.env.prod` / `POSTGRES_PASSWORD` error from compose | File missing or the variable is empty. |
| `port is already allocated` on 38417 | Another service took it: set `APP_PORT=<free port>` in `.env.prod` and the same port in the Nginx `proxy_pass`. |
| Site returns nothing / connection closed | Vhost not enabled, or the host is not matched (the default server returns 444): check `sites-enabled` and the DNS record. |
| 502 from Nginx | App not healthy: `dc ps`, `curl http://127.0.0.1:38417/healthz`. |
| Password change for Postgres has no effect | The password is only applied when the volume is first created. Change it inside Postgres with `ALTER USER`, then update `.env.prod`. |

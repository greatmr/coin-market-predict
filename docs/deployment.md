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
6. **Smoke test**: open the site and sign in as `admin`; optionally run one pipeline now:
   ```bash
   dc exec app node dist/cli.js run-once
   ```
   The scheduler also runs at minute 7 of every hour (UTC).

## Update
```bash
cd /root/jahan/market-predict && git pull
dc up -d --build
```
Data survives: it lives in the named volumes.

## Configuration notes
- Edit `.env.prod`, then `dc up -d` (recreates the app with the new values).
- **`TELEGRAM_MODE=live` needs both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`**, otherwise the app
  refuses to start. Use `dry_run` until credentials are set. Edit the file on the server; do not
  paste tokens into chat or commit them.
- `DATA_SOURCE=coinmarketcap_web` is the only live source with daily rows and LBank pairs
  (see `docs/source-feasibility.md`). `fixture` is synthetic data.
- Check config by key name and length only: `awk -F= '/^[A-Z_]+=/{print $1, length($2)}' .env.prod`.

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
| Log: `Invalid configuration: TELEGRAM_MODE=live requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID` | Add both to `.env.prod`, or set `TELEGRAM_MODE=dry_run`; then `dc up -d`. |
| `.env.prod` / `POSTGRES_PASSWORD` error from compose | File missing or the variable is empty. |
| `port is already allocated` on 38417 | Another service took it: set `APP_PORT=<free port>` in `.env.prod` and the same port in the Nginx `proxy_pass`. |
| Site returns nothing / connection closed | Vhost not enabled, or the host is not matched (the default server returns 444): check `sites-enabled` and the DNS record. |
| 502 from Nginx | App not healthy: `dc ps`, `curl http://127.0.0.1:38417/healthz`. |
| Password change for Postgres has no effect | The password is only applied when the volume is first created. Change it inside Postgres with `ALTER USER`, then update `.env.prod`. |

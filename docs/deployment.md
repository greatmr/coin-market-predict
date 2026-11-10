# Deployment (manual, Docker on the shared server)

Server `65.109.178.236` (`ssh jahantalab`): host Nginx (vhosts in `sites-enabled`, certbot), Docker
with unrelated stacks (`dimension`, `extraction-engine`, `maple`, `services`). This stack is isolated:

- Compose project `coins-predicts-prod`: own containers, network and volumes (`pgdata`, `app_var`).
- Postgres is not published. The app binds `127.0.0.1:38417` only (`APP_PORT` to change). Ports
  3000/8000 are avoided: the `extraction_engine` vhost proxies to them.
- Nginx gets one new vhost file; existing vhosts are not edited.

## First deploy
```bash
# 1. From your Mac: copy the repo (no secrets, deps or build output)
rsync -az --delete --exclude node_modules --exclude dist --exclude var --exclude backups \
  --exclude .git --exclude '.env*' --exclude secrets ./ jahantalab:/opt/coins-predicts/

# 2. On the server: configuration (never committed)
ssh jahantalab
cd /opt/coins-predicts
cat > .env.prod <<'EOF'
POSTGRES_PASSWORD=<long random>
DASHBOARD_BASIC_AUTH=<user>:<long random>   # required: the dashboard is public
DATA_SOURCE=fixture                         # or coinmarketcap_web once chosen
TELEGRAM_MODE=dry_run
# TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... MCP_READ_TOKEN=... (see .env.example)
EOF
chmod 600 .env.prod

# 3. Build and start
docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod up -d --build
curl -fsS http://127.0.0.1:38417/healthz
```
Migrations run on container start (`RUN_MIGRATIONS=true`).

## Nginx and TLS
Cloudflare: `A` record `predict` → `65.109.178.236`.
```bash
cp deploy/nginx/predict.jahantalab.com.conf /etc/nginx/sites-available/predict.jahantalab.com
ln -s /etc/nginx/sites-available/predict.jahantalab.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d predict.jahantalab.com    # adds 443 + redirect (needed: 443 default server returns 444)
```
If Cloudflare proxies the record and certbot's HTTP check fails, set it to DNS-only until the
certificate is issued, or use Cloudflare SSL "Flexible" without certbot.

## Updating
Repeat step 1 (rsync) and step 3. Data survives because volumes are kept.

## Operations
- Logs: `docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod logs -f app`
- Stop: same command with `down` (never add `-v`: it deletes the database volume).

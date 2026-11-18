#!/usr/bin/env bash
# Replace the local database with the latest copy of the production database, then apply the
# local migrations that production does not have yet.
#
#   npm run db:pull-prod                      # download, back up local, restore, migrate
#   npm run db:pull-prod -- --yes             # same, without the confirmation prompt
#   npm run db:pull-prod -- --download-only   # only save the production dump to backups/
#   npm run db:pull-prod -- --from backups/coins-prod-….dump   # restore a dump already downloaded
#
# Options:
#   --yes               do not ask before replacing the local database
#   --download-only     stop after saving the production dump
#   --from FILE         restore FILE (pg_dump -Fc) instead of downloading
#   --server-telegram   keep production's Telegram members and bot offset (default: keep the local ones)
#   --target-db NAME    restore into another database on the local server (default: the database
#                       named in DATABASE_URL)
# Environment: PROD_SSH (default jahantalab), PROD_DIR (default /root/jahan/market-predict).
#
# Production is only read (pg_dump inside its Postgres container, streamed over SSH; nothing is
# written on the server). Locally: the current database is backed up to backups/ first, then dropped
# and recreated from the dump. The whole history (snapshots, batches, scans, reviews, forward test,
# users) becomes production's. Afterwards sign-in sessions and the pipeline lease are cleared (they
# belong to the server), and the local Telegram state is put back unless --server-telegram.
# Never prints DATABASE_URL or any other secret.
set -euo pipefail
cd "$(dirname "$0")/../.."

PROD_SSH="${PROD_SSH:-root@65.109.178.236}"
PROD_DIR="${PROD_DIR:-/root/jahan/market-predict}"
YES=0
DOWNLOAD_ONLY=0
FROM=""
SERVER_TELEGRAM=0
TARGET_DB=""

while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) YES=1 ;;
    --download-only) DOWNLOAD_ONLY=1 ;;
    --from)
      FROM="${2:?--from needs a file}"
      shift
      ;;
    --server-telegram) SERVER_TELEGRAM=1 ;;
    --target-db)
      TARGET_DB="${2:?--target-db needs a name}"
      shift
      ;;
    -h | --help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "pull-prod: unknown option $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
die() {
  echo "pull-prod: $*" >&2
  exit 1
}

# The local Postgres container (docker compose service `postgres`), as its own superuser.
lpsql() { docker compose exec -T postgres sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$@"' psql "$@"; }

check_dump() {
  local tables
  tables=$(docker compose exec -T postgres pg_restore --list <"$1" 2>/dev/null | grep -c 'TABLE DATA' || true)
  echo "$1: $(du -h "$1" | cut -f1), ${tables:-0} tables with data"
  [ "${tables:-0}" -gt 0 ]
}

mkdir -p backups
TS=$(date +%Y-%m-%d-%H%M%S)

docker compose ps --status running --services 2>/dev/null | grep -qx postgres ||
  die "the local Postgres is not running: docker compose up -d postgres"

# 1. The production dump.
if [ -n "$FROM" ]; then
  [ -f "$FROM" ] || die "$FROM does not exist"
  DUMP="$FROM"
  say "Using $DUMP"
else
  DUMP="backups/coins-prod-$TS.dump"
  say "Downloading the production database from $PROD_SSH:$PROD_DIR (read-only pg_dump)"
  # The remote script runs in the production Postgres container; only pg_dump writes to stdout.
  if ! ssh "$PROD_SSH" "PROD_DIR='$PROD_DIR' bash -s" >"$DUMP.part" <<'REMOTE'; then
set -eu
cd "$PROD_DIR"
docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'
REMOTE
    rm -f "$DUMP.part"
    die "the download failed (is 'ssh $PROD_SSH' set up, and the production stack running?)"
  fi
  mv "$DUMP.part" "$DUMP"
fi
check_dump "$DUMP" || die "$DUMP is not a usable pg_dump archive (no table data found)"
if [ "$DOWNLOAD_ONLY" = 1 ]; then
  echo "Saved. Restore it later with: npm run db:pull-prod -- --from $DUMP"
  exit 0
fi

# 2. Which local database (from DATABASE_URL, .env included; only host, port and name are read).
DB_INFO=$(node --env-file-if-exists=.env -e '
  const raw = process.env.DATABASE_URL;
  if (!raw) { console.error("DATABASE_URL is not set"); process.exit(1); }
  const u = new URL(raw);
  console.log([u.hostname, u.port || "5432", decodeURIComponent(u.pathname.slice(1)), process.env.POSTGRES_PORT || "5433"].join(" "));
')
read -r DB_HOST DB_PORT DB_NAME COMPOSE_PORT <<<"$DB_INFO"
case "$DB_HOST" in
  127.0.0.1 | localhost | ::1) ;;
  *) die "DATABASE_URL points to $DB_HOST, not the local Docker Postgres; refusing" ;;
esac
[ "$DB_PORT" = "$COMPOSE_PORT" ] ||
  die "DATABASE_URL uses port $DB_PORT but the local Docker Postgres listens on $COMPOSE_PORT; refusing"
TARGET_DB="${TARGET_DB:-$DB_NAME}"
[[ "$TARGET_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "unexpected database name: $TARGET_DB"

# Nothing may write to the database while it is replaced.
if pgrep -f "dist/(main|cli)\.js" >/dev/null 2>&1 || docker compose ps --status running --services 2>/dev/null | grep -qx api; then
  die "the app or a CLI command is running locally; stop it first (npm start / docker compose --profile app stop api)"
fi

if [ "$YES" != 1 ]; then
  echo
  echo "This REPLACES the local database '$TARGET_DB' (127.0.0.1:$COMPOSE_PORT) with the production copy."
  echo "Its current content is backed up to backups/ first."
  read -r -p "Type the database name to continue: " answer
  [ "$answer" = "$TARGET_DB" ] || die "cancelled"
fi

EXISTS=$(lpsql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'")
KEEP_TG=""
if [ "$EXISTS" = 1 ]; then
  # 3. Back up the local database.
  LOCAL_BACKUP="backups/coins-local-before-pull-$TS.dump"
  say "Backing up local '$TARGET_DB' to $LOCAL_BACKUP"
  docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$1" -Fc' pg_dump "$TARGET_DB" >"$LOCAL_BACKUP"
  check_dump "$LOCAL_BACKUP" || echo "(the local database had no data)"
  # The local bot's own state (approved members, update offset), restored after the copy.
  if [ "$SERVER_TELEGRAM" != 1 ]; then
    KEEP_TG="backups/.telegram-state-$TS.tsv"
    if [ "$(lpsql -d "$TARGET_DB" -Atc "SELECT to_regclass('public.app_state') IS NOT NULL")" = t ]; then
      lpsql -d "$TARGET_DB" -c "COPY (SELECT key, value, updated_at FROM app_state WHERE key LIKE 'telegram.%') TO STDOUT" >"$KEEP_TG"
    else
      : >"$KEEP_TG"
    fi
  fi
fi

# 4. Replace it.
say "Restoring the dump into '$TARGET_DB'"
lpsql -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$TARGET_DB\""
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-privileges --exit-on-error' pg_restore "$TARGET_DB" <"$DUMP"

# 5. Local migrations that production does not have yet (same database as the restore).
say "Applying local migrations"
npx tsc -p tsconfig.build.json
TARGET_DB="$TARGET_DB" node --env-file-if-exists=.env -e '
  const { spawnSync } = require("node:child_process");
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = "/" + process.env.TARGET_DB;
  const env = { ...process.env, DATABASE_URL: u.toString() };
  for (const cmd of ["db:migrate", "db:status"]) {
    const r = spawnSync(process.execPath, ["dist/cli.js", cmd], { stdio: "inherit", env });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
'

# 6. Server-only state.
say "Clearing server sessions and the pipeline lease"
lpsql -d "$TARGET_DB" -c "DELETE FROM user_session" -c "DELETE FROM job_lease"
if [ -n "$KEEP_TG" ]; then
  echo "Keeping the local Telegram members and bot offset (--server-telegram keeps production's)"
  lpsql -d "$TARGET_DB" \
    -c "CREATE TEMP TABLE keep_tg (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL)" \
    -c "COPY keep_tg FROM STDIN" \
    -c "DELETE FROM app_state WHERE key LIKE 'telegram.%'" \
    -c "INSERT INTO app_state (key, value, updated_at) SELECT key, value, updated_at FROM keep_tg" <"$KEEP_TG"
  rm -f "$KEEP_TG"
fi

say "Done: '$TARGET_DB' now holds the production data"
lpsql -d "$TARGET_DB" -P footer=off -c "
  SELECT (SELECT max(slot_time) FROM crawl_batch) AS latest_batch_slot,
         (SELECT count(*) FROM crawl_batch) AS batches,
         (SELECT count(*) FROM scan_run) AS scans,
         (SELECT count(*) FROM review) AS reviews,
         (SELECT count(*) FROM forward_event) AS forward_events,
         (SELECT count(*) FROM app_user) AS users"
echo "Production dump: $DUMP"
[ -n "${LOCAL_BACKUP:-}" ] && echo "Previous local data: $LOCAL_BACKUP (restore: docker compose exec -T postgres pg_restore -U coins -d $TARGET_DB --clean --if-exists < $LOCAL_BACKUP)"
echo "Sign in with your production username and password; local sessions were cleared."

#!/bin/sh
set -eu
# Apply committed migrations only (never `db push` / destructive sync).
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  npx prisma migrate deploy
fi
exec "$@"

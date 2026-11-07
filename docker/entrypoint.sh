#!/bin/sh
set -eu
# Apply the committed TypeORM migrations only (never `synchronize`): src/database/migrations.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  node dist/cli.js db:migrate
fi
exec "$@"

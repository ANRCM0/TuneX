#!/usr/bin/env bash
# Container entrypoint for the panel.
#
# `prisma db push` is the repository's schema mechanism (there is no migrations
# directory). Keep it on by default for a single container; set
# DB_PUSH_ON_START=0 when an init job or a real migration step owns the schema.
set -euo pipefail

cd /app

# `docker compose run --rm backend <cmd>` reaches this branch (for example the seed).
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if [ "${DB_PUSH_ON_START:-1}" = "1" ]; then
  echo "[entrypoint] applying prisma schema to ${DATABASE_URL}"
  pnpm --filter @relayx/backend exec prisma db push \
    --skip-generate \
    --schema apps/backend/prisma/schema.prisma
fi

if [ "${SEED_ON_START:-0}" = "1" ]; then
  echo "[entrypoint] seeding"
  pnpm --filter @relayx/backend seed
fi

exec pnpm --filter @relayx/backend start

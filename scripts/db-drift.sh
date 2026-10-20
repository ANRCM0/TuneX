#!/usr/bin/env bash
#
# Fail when prisma/migrations does not match prisma/schema.prisma, or when the generated
# MySQL schema/baseline is stale. Uses a throwaway shadow database.
#
#   bash scripts/db-drift.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SHADOW="$(mktemp -u -t relayx-shadow-XXXXXX.db)"
trap 'rm -f "$SHADOW" "$SHADOW-journal"' EXIT

echo "=== mysql schema is in sync ==="
node apps/backend/scripts/gen-mysql-schema.mjs --check

echo "=== sqlite migrations match schema.prisma ==="
DIFF="$(
  DATABASE_URL="file:./verify.db" npx prisma migrate diff \
    --from-migrations apps/backend/prisma/migrations \
    --to-schema-datamodel apps/backend/prisma/schema.prisma \
    --shadow-database-url "file:$SHADOW" \
    --script 2>/dev/null
)"
if ! grep -q "empty migration" <<<"$DIFF"; then
  echo "$DIFF" >&2
  echo "prisma/migrations drifted from schema.prisma; run: pnpm db:migrate" >&2
  exit 1
fi
echo "ok"

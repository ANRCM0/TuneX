#!/usr/bin/env bash
#
# Aggregate verification for the RelayX replica.
#
# Runs every check that does not need a live stack, in the same order CI does:
#
#   1. TypeScript typecheck across the workspace (backend, license server,
#      shared).
#   2. Vitest unit suites (backend, shared and the web console).
#      `tests/e2e` smoke self-skips when no backend is listening on RELAYX_BASE_URL.
#   3. License-server vitest suites.
#   3b. Web console: production build of the Next.js app.
#   4. `go vet` and `go test` for the node agent.
#   5. Agent build plus `--version`.
#
# With `--e2e` it then runs `scripts/e2e-local.sh`, which boots a private
# license server, backend, echo target and agent and asserts the full data
# plane (config push, TCP forward, observer accounting). That needs the
# default ports to be free.
#
# Usage:
#   bash scripts/verify.sh          # static + unit checks
#   bash scripts/verify.sh --e2e    # also the live full-stack E2E
#
# Exit code is non-zero on the first failing step.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_E2E=0
for arg in "$@"; do
  case "$arg" in
    --e2e) WITH_E2E=1 ;;
    -h | --help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (use --e2e or --help)" >&2
      exit 2
      ;;
  esac
done

export GOCACHE="${GOCACHE:-$ROOT/.gocache}"
export GOPATH="${GOPATH:-$ROOT/.gopath}"
export DATABASE_URL="${DATABASE_URL:-file:./verify.db}"

step() { printf '\n=== %s ===\n' "$*"; }

step "install (frozen lockfile)"
pnpm install --frozen-lockfile

step "prisma generate + schema push"
pnpm db:generate
pnpm db:push

step "typecheck"
pnpm -r typecheck

step "unit tests (vitest)"
pnpm test

step "license-server tests"
pnpm --filter @relayx/license-server test

step "web build (Next.js standalone)"
pnpm --filter @relayx/web build

step "agent: go vet"
(cd apps/agent && go vet ./...)

step "agent: go test"
(cd apps/agent && go test -p 1 ./...)

step "agent: build"
pnpm agent:build
./dist/relayx-agent --version

if [[ "$WITH_E2E" == "1" ]]; then
  step "live full-stack E2E"
  bash scripts/e2e-local.sh
else
  printf '\nAll static/unit checks passed. Run with --e2e for the live stack.\n'
fi

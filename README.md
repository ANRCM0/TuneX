# RelayX (clean-room replica)

A reconstruction of the RelayX tunnel panel, built from the decompiled binary and the notes in `relayx-analysis/`. It is for interoperability and study. It is not affiliated with the original authors and it is not their source tree.

## Layout

| Path | What |
| --- | --- |
| `apps/backend` | Hono API, Prisma/SQLite, Socket.IO, BullMQ |
| `apps/license-server` | Self-hosted license issuer (port 3100) |
| `apps/agent` | Go node agent |
| `packages/shared` | Shared package (workspace) |
| `tests` | Vitest unit tests |
| `scripts` | `verify.sh` and the live `e2e-local.sh` harness |
| `docs` | Conventions, deviations, agent notes, parity, verification |

Architecture: Hono on Node, Prisma against SQLite, Socket.IO for node agents, BullMQ when Redis is configured, and a business-license gate on pay / ticket / commission / parts of `/admin`.

## Requirements

- Node >= 22
- pnpm 11.7.0
- Go (only for `pnpm agent:build`; this machine has go 1.27)

pnpm 11 reads the native build allowlist from `pnpm-workspace.yaml` `allowBuilds:`, not from `package.json` `pnpm.onlyBuiltDependencies`. The allowlist is `@prisma/client`, `@prisma/engines`, `esbuild`, `msgpackr-extract`, `prisma`.

## Quick start

```bash
pnpm install
pnpm db:generate
pnpm db:push
pnpm seed          # prints the admin api_key
pnpm dev           # http://127.0.0.1:3000
```

`pnpm seed` creates the super admin with a deterministic dev `api_key`
(`a34d563e-9efe-4047-9e20-05a9678ef5fb`, also used by `tests/e2e/smoke.test.ts`).
Set `SEED_ADMIN_API_KEY` (and `SEED_ADMIN_EMAIL`) to override. Re-seeding an existing
database keeps the old key.

Copy `.env` and set at least:

- `DATABASE_URL` (SQLite file)
- `CONFIG_SECRET` (32-byte url-safe base64 Fernet key; the repo default lets the process boot, replace it)
- `LICENSE_URL` (default `http://127.0.0.1:3100`)

The API starts with no `REDIS_URL` and no `TELEGRAM_BOT_TOKEN`. Those features log a skip line and stay idle.

### Base path

Upstream registers every route at the root and relies on its reverse proxy to strip a leading `/api`, while its self-referential URLs (node observer callback, payment notify callback, OpenAPI `servers`) all include `/api`. `apps/backend/src/index.ts` emulates that single rewrite, so `GET /plan` and `GET /api/plan` both work. See `docs/DEVIATIONS.md` item 19.

Call protected routes with `Authorization: Bearer <api_key>` from `pnpm seed`.

## License server

`/pay`, `/ticket/*`, `/commission/*`, and several `/admin/*` routes return 403 until the panel has a business license.

```bash
pnpm --filter @relayx/license-server start
# other terminal, from the repo root:
npx tsx apps/license-server/src/index.ts --db apps/license-server/license.db \
  issue --site-url http://127.0.0.1:3000 --type business
```

The server defaults to port **3100**.

## Agent

```bash
export GOCACHE=/workspace/111/.gocache GOPATH=/workspace/111/.gopath   # if the default cache is not writable
pnpm agent:build
./dist/relayx-agent --server http://127.0.0.1:3000 --token <node-group-token>
```

Details and the implemented-vs-stubbed table: [docs/AGENT.md](docs/AGENT.md).

## Scripts

| Script | Effect |
| --- | --- |
| `pnpm db:generate` | `prisma generate` for `apps/backend/prisma/schema.prisma` |
| `pnpm db:push` | Push the schema to SQLite |
| `pnpm db:reset` | `prisma db push --force-reset` (destroys data) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm seed` | Seed the super admin and print `api_key` |
| `pnpm dev` | Backend with `tsx watch` |
| `pnpm start` | Backend without watch |
| `pnpm typecheck` | `tsc --noEmit` in every workspace package |
| `pnpm test` | `vitest run` |
| `pnpm test:e2e` | `vitest run tests/e2e` |
| `pnpm agent:build` | `go build -o dist/relayx-agent ./cmd/relayx-agent` |

Backend-only: `pnpm --filter @relayx/backend zod:generate` regenerates scalar zod models. License server: `dev`, `start`, `typecheck`, `test`.

Repo scripts (not pnpm scripts):

| Script | Effect |
| --- | --- |
| `bash scripts/verify.sh` | install + prisma push + typecheck + unit tests + license tests + `go vet`/`go test` + agent build |
| `bash scripts/verify.sh --e2e` | the same, then the live full-stack E2E |
| `bash scripts/e2e-local.sh` | boots a private license server, backend, echo target and agent on a throwaway database, then asserts the config push, TCP forwarding, observer path and traffic accounting |

## Tests

Run `pnpm test` and `pnpm typecheck` for current counts, or `bash scripts/verify.sh` for the whole matrix (the live stack is `bash scripts/verify.sh --e2e`). [docs/VERIFY.md](docs/VERIFY.md) records what each check asserts. Latest full pass on a fresh SQLite database:

- `pnpm -r typecheck` — exit 0
- `pnpm test` — 40 files, 410 passed (the live smoke case self-skips when no backend is listening)
- `pnpm test:e2e` — 1 passed
- `pnpm --filter @relayx/license-server test` — 6 files, 44 passed
- `go vet ./...` and `go test ./...` in `apps/agent` — clean, all packages ok
- Live agent end-to-end (`scripts/e2e-local.sh`): Fernet config with 2 services applied, TCP forward echoed through the tunnel, the observer reached the backend through the deployment `/api` prefix, `tunnel.traffic` / `userPlan.traffic_used` incremented by exactly `0.00390625` GiB, and `/openapi.json` served 116 paths

`docs/PARITY.md` is the route-by-route diff and is written by the verify pass. If that file is missing, the verify task has not landed yet. `docs/COVERAGE.md` maps each layer to the suite that checks it.

## Route groups

Mounted in `apps/backend/src/app.ts`.

| Group | Guard |
| --- | --- |
| `/queuedash`, `/health` | none (before auth) |
| `/docs`, `/openapi.json` | business license |
| `/admin/*` | auth, admin, admin permission; extra business license and/or super-admin on pay, plan coupon, topup activity, ticket, withdraw, role |
| `/pay`, `/plan/coupon`, `/ticket/*`, `/commission/*` | auth + business license |
| `/tunnel`, `/node`, `/node/group`, `/user`, `/license`, `/plan`, `/topup`, `/system/config`, `/bot`, `/in_node_group_dns`, `/dns_provider` | auth |

`/license` is mounted twice on the public router, matching upstream.

## Docs

- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — how the replica is structured
- [docs/DEVIATIONS.md](docs/DEVIATIONS.md) — where it differs from the decompile
- [docs/AGENT.md](docs/AGENT.md) — build and run the node agent
- [docs/PARITY.md](docs/PARITY.md) — full route diff (verify task)
- [docs/VERIFY.md](docs/VERIFY.md) — verification matrix, live E2E harness, known gaps
- [docs/COVERAGE.md](docs/COVERAGE.md) — which suite covers which layer, and what is intentionally not covered
- [docs/REPLICATION.md](docs/REPLICATION.md) — remaining replication phases

## Legal / provenance

This tree was reconstructed from a decompiled binary and the analysis notes next to it. It is not the original product, not a drop-in claim of ownership, and not endorsed by the upstream authors. Do not point the default Fernet key or the seeded admin key at anything you care about.

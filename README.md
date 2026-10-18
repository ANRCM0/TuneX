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
| `docs` | Conventions, deviations, agent notes, parity |

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

## Tests

Run `pnpm test` and `pnpm typecheck` for current counts. Latest full pass on a fresh SQLite database:

- `pnpm -r typecheck` — exit 0
- `pnpm test` — 10 files, 81 passed (includes the live smoke test against a running backend)
- `pnpm test:e2e` — 1 passed
- `pnpm --filter @relayx/license-server test` — 6 files, 44 passed
- `go vet ./...` and `go test ./...` in `apps/agent` — clean, all packages ok
- Live agent end-to-end: Fernet config with 2 services applied, TCP `127.0.0.1:18080 → 127.0.0.1:19081` echoed `pong:hello-relayx`, observer posted and `tunnel.traffic` / `userPlan.traffic_used` incremented

`docs/PARITY.md` is the route-by-route diff and is written by the verify pass. If that file is missing, the verify task has not landed yet.

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

## Legal / provenance

This tree was reconstructed from a decompiled binary and the analysis notes next to it. It is not the original product, not a drop-in claim of ownership, and not endorsed by the upstream authors. Do not point the default Fernet key or the seeded admin key at anything you care about.

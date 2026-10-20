# RelayX replica — implementation conventions

This file is the contract for every contributor to `/workspace/111/relayx`. Read it before
writing code. It describes what is already frozen, what you own, and the exact rules that
keep independently-written modules compiling together.

## 1. What this project is

`relayx-analysis/` holds a decompiled, module-by-module reconstruction of the original
RelayX backend (a Bun + Hono + Prisma + Socket.IO tunnel-proxy control plane) plus its
Go node agent and its license server. `/workspace/111/relayx` is a **faithful replica** of
that system on a conventional Node.js + TypeScript + SQLite toolchain.

The analysis tree is the **source of truth**. When this document and the analysis
disagree, the analysis wins — and if you must deviate, record it in
[`docs/DEVIATIONS.md`](./DEVIATIONS.md).

Useful entry points in the analysis:

- `relayx-analysis/work/prisma_schema.prisma` — the original MySQL schema.
- `relayx-analysis/work/modules/<idx>__<path>.ts` — the backend modules. The `idx` is the
  decompiler's module index; `module_index.json` and `modules_manifest.json` map them.
- `relayx-analysis/work/shared/` — the `packages/shared` sources.
- `relayx-analysis/work/agent/`, `relayx-analysis/work/verify/` — agent and verification
  material.

**Do not edit anything under `relayx-analysis/`.** It is read-only input.

## 2. Repository layout

```
relayx/
  apps/
    backend/          @relayx/backend   — the API server (yours, mostly)
      prisma/schema.prisma              — frozen; SQLite port of the original schema
      scripts/generate-zod.mjs          — regenerates src/generated/zod
      src/…
    web/              @relayx/web — the panel UI (Next.js 16, separate vertical)
    agent/            Go node agent (separate vertical)
    license-server/   license/pay/coupon service (separate vertical)
  packages/shared/    @relayx/shared    — frozen: date/fernet/pay/permissions/telegram
  tests/              vitest suites
  docs/               this file + DEVIATIONS.md + API notes
```

## 3. Frozen kernel — do not modify

These exist, typecheck, and are relied on by everything. If you need a change, message the
Lead instead of editing.

| File                                                                                                                 | Provides                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/config.ts`                                                                                         | env loading, `isProduction()`, `SITE_URL`, `LICENSE_URL`, …                                                                                                         |
| `apps/backend/src/db.ts`                                                                                             | `prisma` / `db` (same client) and `Db` type                                                                                                                         |
| `apps/backend/src/logger.ts`                                                                                         | `logger` (pino)                                                                                                                                                     |
| `apps/backend/src/container.ts`                                                                                      | `TOKENS`, `register`/`resolve`/`service`/`instance`                                                                                                                 |
| `apps/backend/src/types.ts`                                                                                          | `AppEnv`, `SessionUser`, `SessionPlan`                                                                                                                              |
| `apps/backend/src/openapi.ts`                                                                                        | `describeRoute`, `h2`, `zValidator`, `resolver`                                                                                                                     |
| `apps/backend/src/generated/zod/index.ts`                                                                            | `<Model>Schema` for every Prisma model (generated)                                                                                                                  |
| `apps/backend/src/schemas/request.ts`                                                                                | all request schemas                                                                                                                                                 |
| `apps/backend/src/schemas/response.ts`                                                                               | all response schemas                                                                                                                                                |
| `apps/backend/src/services/redis.ts`                                                                                 | `KEY`, `client`, `lock`, `RedisService`, `redisService`                                                                                                             |
| `apps/backend/src/services/redis-memory.ts`                                                                          | in-process Redis used when `REDIS_URL` is empty                                                                                                                     |
| `apps/backend/src/services/system_config.ts`                                                                         | `DefaultConfig`, `systemConfigService`                                                                                                                              |
| `apps/backend/src/services/notify-types.ts`                                                                          | `NotifyType`, `AdminNotifyType`, channel helpers                                                                                                                    |
| `apps/backend/src/services/license.ts`                                                                               | `licenseService`, `LicenseType`, `CouponValidCycle`                                                                                                                 |
| `apps/backend/src/services/stackauth.ts`                                                                             | `stackAuthService`                                                                                                                                                  |
| `apps/backend/src/services/email.ts`                                                                                 | `emailService.sendEmail(to, subject, text, html?)`                                                                                                                  |
| `apps/backend/src/services/fernet.ts`                                                                                | `fernetService.encrypt/decrypt`                                                                                                                                     |
| `apps/backend/src/services/io-registry.ts`                                                                           | `setIo` / `getIo`                                                                                                                                                   |
| `apps/backend/src/middlewares/*`                                                                                     | `getRequestIP`, `requestLogger`, `sentry`, `authRequired`, `adminRequired`, `adminPermissionGuard`, `superAdminRequired`, `businessLicenseRequired`, `planRequired` |
| `apps/backend/src/routes/health.ts`, `routes/license.ts`, `routes/system_config.ts`, `routes/admin/system_config.ts` | those routes                                                                                                                                                        |
| `apps/backend/src/app.ts`, `src/index.ts`, `src/seed.ts`                                                             | assembly                                                                                                                                                            |
| `packages/shared/**`                                                                                                 | shared contracts                                                                                                                                                    |

`app.ts` already mounts **every** route module, including yours. Route files you own
currently exist as placeholders that export `new Hono()`; replace their bodies, keep
`export default router`.

## 4. Hard rules

1. **No file extensions in relative imports.** `moduleResolution` is `Bundler`.
   `import { x } from "../services/foo"` — never `"../services/foo.js"`.
2. **Services self-register.** End every service module with:
   ```ts
   export const fooService = service<FooService>(TOKENS.Foo, () => new FooService(…));
   ```
   `service()` registers a factory and returns a lazily-resolving proxy, so call sites read
   exactly like the decompiled original (`fooService.bar(...)`) and circular imports are
   safe. Never build a central registry — it would create cross-team write conflicts.
3. **Only touch files inside your task's write scope.** Everything else is someone else's.
4. **No new dependencies without asking the Lead.** The dependency set is frozen so seven
   people can install in parallel without lockfile races. `pnpm add` from one teammate
   invalidates everyone's `node_modules`.
5. **Localization.** All user-facing strings are Simplified Chinese and must match the
   decompiled original byte-for-byte where the analysis shows them.
6. **Errors.** Throw `new HTTPException(status, { message })` from `hono/http-exception`;
   `app.onError` turns it into `{ error: message }`. Do not invent new error envelopes.
7. **Typecheck before you report done:** `pnpm --filter @relayx/backend typecheck`.
   The kernel currently compiles with zero errors; do not leave it worse.
8. **Never edit `prisma/schema.prisma`.** The SQLite port is frozen and the database has
   already been pushed. If a field seems missing, check the analysis again — it is usually
   a relation or a JSON column.

## 5. Date columns and raw SQL

The original ran on MySQL; the replica runs on SQLite by default and on MySQL through the
generated variant. `apps/backend/src/utils/date.ts` owns the difference, so a route never has
to know which engine it is on. Four rules:

1. **Never hand-write a dialect.** Use `toLocalTZ(col)`, `getDateGroupBy(col, aggregate)`,
   `localNowMinusDays(n)` or `utcNowMinusDays(n)`; do not write `datetime('now', …)`,
   `strftime(…)`, `CONVERT_TZ(…)`, `DATE_FORMAT(…)` or `NOW()` in a route.
   `tests/unit/aggregate-dialect.test.ts` fails if a consumer starts doing that.
   The builders return text in one fixed `YYYY-MM-DD HH:MM:SS`-family shape on both engines,
   which is why string bounds compare identically (`docs/MYSQL.md`).
2. **SQLite stores `DateTime` as INTEGER unix milliseconds** (`typeof(created_at)` is
   `'integer'`), MySQL as `DATETIME(3)` in UTC. The helpers normalise both to Asia/Shanghai
   text; a raw query that compares a `DateTime` column without them is engine-specific.
3. **`Json` columns are TEXT on SQLite.** Prisma handles (de)serialisation for typed model
   access, but raw SQL sees a JSON string.
4. Prisma's SQLite connector does **not** support `createMany({ skipDuplicates: true })`.
   Use a loop with `upsert`.

## 6. Verification expectations

Every vertical must, at minimum:

- `pnpm --filter @relayx/backend typecheck` — passes.
- Exercise its own routes against a running server (`pnpm dev`, port 3000) or through a
  focused vitest file, and report the exact commands and observed responses.
- Confirm the SQLite DDL matches what its queries assume
  (`apps/backend/prisma/dev.db`, `sqlite3 dev.db .schema`).

The Lead runs the end-to-end pass. Use `pnpm db:reset && pnpm db:push && pnpm seed` to get
a clean database.

## The web app owns its own conventions

`apps/web` is a separate vertical like the agent: it has its own toolchain (Next 16 +
Turbopack), its own tests (`tests/unit/web-*.test.ts`) and its own documentation
([`docs/WEB.md`](./WEB.md)). Rules that matter when touching it:

1. **No Chinese literals in code.** Every user-visible string goes through `t()` / `tf()` from
   `@/lib/i18n`; the dictionary lives in `src/lib/i18n/zh-CN.ts` and is guarded by
   `tests/unit/web-i18n.test.ts`. Comments and the five backend-error regexes are the only
   exceptions (the backend answers with Chinese error strings — see reports/10 U1).
2. **RBAC constants come from `@relayx/shared/permissions`.** Never re-declare the resource
   table in the console; the backend guards and the console must resolve the same keys.
3. **List pages are client-rendered.** A route that reads URL state (`nuqs`) is a server
   wrapper with `export const dynamic = "force-dynamic"` around a `view.tsx` client module.
4. **Route changes update `apps/web/routes.json`.** `tests/unit/web-routes.test.ts` fails when
   the manifest and the file tree disagree, and `/handler/[...stack]` is the only entry
   allowed to say `implemented: false`.
5. **API calls go through `src/lib/client.ts`** (Hono-RPC style). Do not hand-roll `fetch`;
   the wrapper owns impersonation, the 401/403 redirects and the toast contract.

# MySQL target

The replica runs on SQLite out of the box, because the crate has to boot with zero external
services. Upstream uses MySQL 8, so the repository also ships a MySQL variant of the same
data model plus a CI job that proves it against a real server.

## What exists

| Path                                              | Role                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/backend/prisma/schema.prisma`               | The SQLite schema — the source of truth, pinned to the decompiled upstream by `tests/unit/schema-parity.test.ts` |
| `apps/backend/prisma/migrations/0001_init/`       | SQLite baseline migration                                                                                        |
| `apps/backend/prisma/mysql/schema.prisma`         | **Generated** MySQL variant (only the `datasource` block differs)                                                |
| `apps/backend/prisma/mysql/migrations/0001_init/` | **Generated** MySQL baseline DDL                                                                                 |
| `apps/backend/scripts/gen-mysql-schema.mjs`       | Generator; `--check` is read-only and fails on staleness                                                         |
| `apps/backend/scripts/mysql-smoke.mjs`            | Runtime smoke: JSON, enums, Float, DateTime, uniques, cascades                                                   |
| `.github/workflows/mysql.yml`                     | Applies the baseline to `mysql:8.0`, checks drift, generates the client, runs the smoke                          |
| `tests/unit/mysql-workflow.test.ts`               | Asserts the workflow contract and that `--check` cannot repair what it checks                                    |

Prisma requires the datasource provider to be a **string literal**, so one schema file cannot
serve both engines. That is why MySQL lives in its own directory rather than behind `env()`.

## Running it

```bash
# regenerate the variant after editing schema.prisma
pnpm db:mysql:generate

# copy it, then restore whatever was there
cp -a apps/backend/prisma/mysql /tmp/mysql-restore

# against a real server
export MYSQL_URL="mysql://root:pass@127.0.0.1:3306/relayx"
DATABASE_URL="$MYSQL_URL" pnpm db:mysql:deploy    # baseline migration
npx prisma generate --schema apps/backend/prisma/mysql/schema.prisma
DATABASE_URL="$MYSQL_URL" pnpm db:mysql:smoke
```

`prisma generate --schema …/mysql/schema.prisma` writes into the shared
`node_modules/.prisma/client` slot, so it **replaces** the SQLite client. Run `pnpm db:generate`
afterwards to get the SQLite client back.

## What CI proves

`MySQL target` runs only when the schema, the generator, the smoke script or the SQLite date
helpers change (and on demand via `workflow_dispatch`):

1. `pnpm db:mysql:generate --check` — the committed MySQL schema is current;
2. `pnpm db:mysql:deploy` — the baseline DDL applies to an empty MySQL 8;
3. `prisma migrate diff --from-migrations … --shadow-database-url …` — no drift;
4. `prisma generate` from the MySQL schema, then `mysql-smoke.mjs`:
   JSON round-trip (nested object + array), enum round-trip, `Float` keeps `0.00390625`,
   `DateTime` keeps milliseconds, `email` uniqueness rejects duplicates, `_sum` aggregate is
   exact, deleting a `NodeGroup` cascades to its `Node` rows.

## Known gaps

These are **not** covered, and the workflow fails if the documentation is deleted without
addressing them:

- **Aggregate endpoints are SQLite dialect.** `apps/backend/src/utils/date.ts` emits
  `datetime(col / 1000, 'unixepoch', '+8 hours')` and `strftime(...)`, and
  `services/stats.ts`, `routes/admin/plan.ts`, `routes/admin/topup.ts`, `routes/tunnel.ts` and
  `routes/user.ts` interpolate that into raw SQL. On MySQL every one of those queries is a
  syntax error, so `/admin/stats`, `/admin/stats/traffic`, `/tunnel/traffic/stats`,
  `/user/referral/stats` and the plan/topup dashboards would fail.
- **No MySQL run of the backend itself.** The job proves the _schema and client_, not the HTTP
  surface: the backend test suite is SQLite-only (date helpers, `db push`).
- **`DateTime` storage differs by engine.** SQLite holds unix milliseconds, MySQL `DATETIME(3)`.
  Parameterised Prisma comparisons agree on both; raw string comparisons do not.
- **No migration history beyond the baseline.** The baseline was generated from the schema as
  it stands; the upstream project's own migration history is not recoverable from the binary.

### Making the panel MySQL-ready

Replace the SQLite dialect helpers with a provider switch, for example:

```ts
// utils/date.ts
const isMySQL = (process.env.DATABASE_URL ?? "").startsWith("mysql://");
export const toLocalTZ = (column: string) =>
  isMySQL
    ? `CONVERT_TZ(${column}, '+00:00', '+08:00')`
    : `datetime(${column} / 1000, 'unixepoch', '+8 hours')`;
```

and the `strftime('%Y-%m', …)` branches with `DATE_FORMAT(…, '%Y-%m')` / `'%Y'`. Then extend
`mysql.yml` with a second step that boots the backend against MySQL and hits the aggregate
endpoints. Until that lands, this page is the accurate statement of compatibility.

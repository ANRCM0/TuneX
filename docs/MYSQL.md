# MySQL target

The replica runs on SQLite out of the box, because the crate has to boot with zero external
services. Upstream uses MySQL 8, so the repository also ships a MySQL variant of the same
data model plus a CI job that proves it against a real server.

Both targets are first-class: the schema, the generated client, the **whole backend test
suite** and the aggregate endpoints that used to be SQLite-only are covered. The SQL switch is
one module, `apps/backend/src/utils/date.ts`, keyed off `DATABASE_URL`; the test-database
harness is switched the same way.

## What exists

| Path                                              | Role                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/backend/prisma/schema.prisma`               | The SQLite schema — the source of truth, pinned to the decompiled upstream by `tests/unit/schema-parity.test.ts` |
| `apps/backend/prisma/migrations/0001_init/`       | SQLite baseline migration                                                                                        |
| `apps/backend/prisma/mysql/schema.prisma`         | **Generated** MySQL variant: `datasource` + the native types the SQLite port drops                               |
| `apps/backend/prisma/mysql/migrations/0001_init/` | **Generated** MySQL baseline DDL                                                                                 |
| `apps/backend/scripts/gen-mysql-schema.mjs`       | Generator; `--check` is read-only and fails on staleness                                                         |
| `apps/backend/scripts/mysql-smoke.mjs`            | Runtime smoke: JSON, enums, Float, DateTime, uniques, FK actions                                                 |
| `apps/backend/scripts/mysql-endpoints-smoke.mjs`  | Boots the backend on MySQL and asserts the aggregate endpoints over HTTP                                         |
| `apps/backend/scripts/mysql-test-db.mjs`          | Creates/drops a suite's MySQL database and replays the baseline DDL; `sweep` removes leftovers                   |
| `tests/helpers/temp-db.ts`                        | Per-suite database: temp SQLite file, or a dedicated MySQL database when `RELAYX_TEST_DIALECT=mysql`             |
| `apps/backend/src/utils/date.ts`                  | Both SQL dialects for the aggregate queries; `DATABASE_URL` selects one at call time                             |
| `.github/workflows/mysql.yml`                     | Applies the baseline, checks drift, generates the client, runs the suite and both smokes                         |
| `tests/unit/mysql-workflow.test.ts`               | Asserts the workflow contract and that `--check` cannot repair what it checks                                    |
| `tests/unit/aggregate-dialect.test.ts`            | Asserts the aggregate call sites delegate to `utils/date.ts` and never hand-write a dialect                      |
| `tests/unit/date.test.ts`                         | Pins both branches and the `DATABASE_URL` switch                                                                 |

Prisma requires the datasource provider to be a **string literal**, so one schema file cannot
serve both engines. That is why MySQL lives in its own directory rather than behind `env()`.

The generated variant also restores the **native column types** the SQLite port had to drop
(`@db.VarChar(255)` / `@db.Text` / `@db.Json`), taken from the recovered upstream schema in
`relayx-analysis/work/prisma_schema.prisma` and kept in `NATIVE_TYPES` in the generator.
Without them every `String` becomes `VARCHAR(191)`, which is narrower than upstream and too
short for the prose columns upstream declared as `TEXT` — running the backend suite on MySQL is
what found that (`P2000: the provided value for the column is too long`, `Ticket.content`).

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
DATABASE_URL="$MYSQL_URL" pnpm db:mysql:smoke     # schema/client round-trip
DATABASE_URL="$MYSQL_URL" pnpm db:mysql:endpoints # HTTP: boots the panel and calls the aggregates

# the whole backend suite against MySQL instead of SQLite
DATABASE_URL="$MYSQL_URL" pnpm test:mysql
```

`pnpm test:mysql` is `RELAYX_TEST_DIALECT=mysql vitest run` — **parallel**, like the SQLite run.
The suites call `createTempDatabase()` at module scope and expect a clean database, so the MySQL
branch of `tests/helpers/temp-db.ts` creates a database of its own for every suite
(`relayx_t_<suite>_<pid>_<n>`) through `apps/backend/scripts/mysql-test-db.mjs`, then replays the
committed baseline DDL (55 statements) into it. The database in `DATABASE_URL` is only the
maintenance connection: suites never write to it, so workers cannot collide.
`cleanup()` drops the database, and `node apps/backend/scripts/mysql-test-db.mjs sweep` drops any
`relayx_t_*` a crashed suite left behind (the workflow runs it with `if: always()`).

Replaying the baseline rather than `prisma db push` is deliberate: it is the exact file CI
applies and `prisma migrate diff` checks, it is ~55 round trips instead of a schema diff, and
it keeps `schema.prisma` out of the test path.

`mysql-endpoints-smoke.mjs` starts the backend itself on `MYSQL_SMOKE_PORT` (default 3311),
seeds a super admin plus fixtures around a Shanghai midnight, and asserts exact bucketed
values. It needs no Redis: the in-process substitute is used, and the fixtures sit outside the
"today" window that would merge live counters.

`prisma generate --schema …/mysql/schema.prisma` writes into the shared
`node_modules/.prisma/client` slot, so it **replaces** the SQLite client. Run `pnpm db:generate`
afterwards to get the SQLite client back.

## One aggregate SQL, two dialects

Upstream is MySQL-only and interpolates `CONVERT_TZ(...)` / `DATE_FORMAT(...)` / `NOW()`.
SQLite has none of those and stores `DateTime` as unix milliseconds. `utils/date.ts` therefore
exports the dialect-aware builders below, chosen by `sqlDialect()`:

| Builder                               | SQLite                                          | MySQL                                                                                                       |
| ------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `toLocalTZ(col)`                      | `datetime(col / 1000, 'unixepoch', '+8 hours')` | `DATE_FORMAT(CONVERT_TZ(col,'+00:00','+08:00'), '%Y-%m-%d %H:%i:%s')`                                       |
| `getDateGroupBy(col, 'day')`          | `date(datetime(col / 1000, …))`                 | `DATE_FORMAT(CONVERT_TZ(col,'+00:00','+08:00'), '%Y-%m-%d')`                                                |
| `getDateGroupBy(col, 'month'/'year')` | `strftime('%Y-%m', …)` / `strftime('%Y', …)`    | `DATE_FORMAT(…, '%Y-%m')` / `DATE_FORMAT(…, '%Y')`                                                          |
| `localNowMinusDays(n)`                | `datetime('now','+8 hours','-N days')`          | `DATE_FORMAT(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+08:00'), INTERVAL N DAY), '%Y-%m-%d %H:%i:%s')` |
| `utcNowMinusDays(n)`                  | `datetime('now','-N days')`                     | `DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(), INTERVAL N DAY), '%Y-%m-%d %H:%i:%s')`                               |

Three properties make the switch safe, and are the invariants to preserve:

1. **Both branches produce text in one fixed shape.** The routes either interpolate bounds
   (`plan`/`topup`/`tunnel`/`user`) or bind them as parameters (`services/stats.ts`); in both
   cases the comparison is text-to-text, and for `YYYY-MM-DD HH:MM:SS` lexicographic order is
   chronological order. MySQL's temporal-vs-string comparison rules never enter the picture.
2. **Both branches render Asia/Shanghai wall-clock time.** MySQL runs against
   `DATETIME(3)` values that Prisma writes in UTC, so the MySQL branch converts
   `+00:00 → +08:00` exactly like the SQLite `'+8 hours'` modifier. `NOW()`/`CURRENT_TIMESTAMP`
   would be session-timezone dependent and are not used; the bound is derived from
   `UTC_TIMESTAMP()` instead.
3. **Prisma returns a string in both cases**, because `DATE_FORMAT`/`date()`/`strftime()` all
   yield text, so `formatStatsDate` formats a string on either engine.

`/tunnel/traffic/stats` deliberately keeps upstream's _UTC_ bound (`utcNowMinusDays`): it has
always compared the Shanghai rendering of `tunnel_traffic.date` against a plain
`datetime('now', '-N days')` (upstream `NOW() - INTERVAL n DAY`). The eight-hour skew is
upstream behaviour, not a replica bug, and it is not "fixed" here.

`DATABASE_URL` is the switch because it is the only runtime signal that matches the generated
client: Prisma requires the provider literal in the schema file, so the URL is what tells a
MySQL deployment apart. Anything that does not start with `mysql` selects SQLite.

## What CI proves

`MySQL target` runs only when the schema, the scripts, the dialect helpers, the aggregate
routes or their tests change (and on demand via `workflow_dispatch`):

1. `pnpm db:mysql:generate --check` — the committed MySQL schema is current;
2. `pnpm db:mysql:deploy` — the baseline DDL applies to an empty MySQL 8;
3. `prisma migrate diff --from-migrations … --shadow-database-url …` — no drift;
4. `prisma generate` from the MySQL schema, then `pnpm test:mysql` — the **entire backend
   vitest suite** (61 files) runs against the MySQL client, each file in its own database, in
   parallel, so every service and route the suite exercises is proven on MySQL;
5. `mysql-smoke.mjs`:
   JSON round-trip (nested object + array), enum round-trip, `Float` keeps `0.00390625`,
   `DateTime` keeps milliseconds, `email` uniqueness rejects duplicates, `_sum` aggregate is
   exact, a `NodeGroup` that still has `Node` rows refuses deletion (RESTRICT) while deleting a
   `User` removes its `LocalCredential` (CASCADE);
6. `mysql-endpoints-smoke.mjs` — the backend boots on the MySQL client and answers, with the
   expected Asia/Shanghai buckets:
   - `/admin/stats` counts by status / node type;
   - `/admin/stats/user` by `day`, `month` and `year` across a Shanghai midnight rollover;
   - `/admin/stats/traffic` day and month buckets over the `tunnel` join;
   - `/admin/plan/stats`, `/admin/topup/stats` (pending orders excluded);
   - `/tunnel/traffic/stats` (caller-scoped), `/user/referral/stats` (referrals + referral
     commission, other commission types excluded);
   - every one of those routers once **without** date parameters, which is the only path that
     executes `localNowMinusDays` / `utcNowMinusDays` — the old MySQL syntax errors lived
     exactly there.

A final step greps `utils/date.ts` for both branches, asserts the suite step, the endpoint
smoke and the harness are still wired, and that `docs/MYSQL.md` still has a `Known gaps`
section, so the documentation cannot drift away from what the job actually runs.

## Known gaps

These are **not** covered, and the workflow fails if the documentation is deleted without
addressing them:

- **The MySQL run pays for a database per suite.** Each suite creates its database and replays
  55 DDL statements (~0.3 s), then drops it; on a server with slow DDL that is the dominant cost
  of the job. A pool of pre-created databases would remove it, but it needs a sweep on every
  exit path and MySQL has no `CREATE DATABASE … TEMPLATE`, so the schema still has to be
  replayed per database.
- **`DateTime` storage differs by engine.** SQLite holds unix milliseconds, MySQL
  `DATETIME(3)`. The helpers normalise that difference for the aggregate queries; a new raw
  query that compares a `DateTime` column as a string, without going through `utils/date.ts`,
  would still be engine-specific.
- **No Redis in CI.** The MySQL job runs with the in-process Redis substitute, so the "today"
  merge in `/admin/stats/traffic` and `/tunnel/traffic/stats` contributes no live counters.
  That path is dialect-free (it sums numbers in JS) but it is not exercised end-to-end there.
- **No migration history beyond the baseline.** The baseline was generated from the schema as
  it stands; the upstream project's own migration history is not recoverable from the binary.

### Adding an aggregate query

Use `toLocalTZ`, `getDateGroupBy`, `localNowMinusDays` or `utcNowMinusDays`; never write
`datetime('now', …)`, `strftime(…)`, `CONVERT_TZ(…)`, `DATE_FORMAT(…)` or `NOW()` in a route.
`tests/unit/aggregate-dialect.test.ts` fails if a consumer starts doing that, and the CI
endpoint step fails if the MySQL branch is wrong.

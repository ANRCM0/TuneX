# Route and schema parity

Compared on 2026-10-17 against `relayx-analysis/work/api_map.json` (`routes` length 160, 157 distinct method+path pairs).

The replica's Hono tree was enumerated with `node --import tsx` importing `apps/backend/src/app.ts` and reading `app.routes` (methods other than `ALL` dropped, then unique `METHOD path`).

## Route counts

| Set | Count |
| --- | --- |
| Upstream registrations | 160 |
| Upstream distinct method+path | 157 |
| Replica distinct method+path | 163 |
| Upstream method+path missing from the replica | **0** |
| Replica method+path not in the upstream `routes` array | **6** |

The 6 extras are real upstream mounts that the api map records outside the `routes` array (they are registered before `authRequired`, or they are the docs endpoints):

| Method | Path |
| --- | --- |
| GET | `/queuedash` |
| GET | `/health` |
| GET | `/health/diag` |
| GET | `/health/heap` |
| GET | `/docs` |
| GET | `/openapi.json` |

`/license` is mounted twice in `app.ts`, matching upstream. Hono collapses that to one method+path in this unique-route diff, so the duplicate registration is not visible as an extra path.

## What this diff does not prove

- Middleware registered inside route files (`zValidator` targets, per-handler `getRequestIP`) is not compared to `api_map.json`'s per-route chain. The app-level guard chain is — see "Guard parity" below.
- Response bodies are only spot-checked; error payloads and status codes are asserted where a test exists, not for all 160 routes.
- Aggregation SQL is covered by `tests/unit/date.test.ts` (the helper strings, plus a SQLite check that 2024-12-31 16:00:00Z buckets as 2025-01-01 / 2025-01 / 2025 in Asia/Shanghai).

## Guard parity (re-derived 2026-10-19)

`tests/unit/route-guards.test.ts` cross-checks three sources: the replica's `app.use(...)` wiring parsed from `apps/backend/src/app.ts`, the decompiled upstream wiring (`relayx-analysis/work/modules/112__src__app.ts:34-73`), and the per-route `middlewareChain` in `relayx-analysis/work/api_map.json`.

Results:

| Check | Result |
| --- | --- |
| Ordered `use(path, guards…)` list vs upstream | identical: `authRequired` on `*`, `adminRequired` + `adminPermissionGuard` on `/admin/*`, nine `businessLicenseRequired` entries, `superAdminRequired` before `businessLicenseRequired` on `/admin/role` and `/admin/role/*` |
| Top-level mount prefixes vs upstream | identical, including the two `/license` registrations and `/queuedash` + `/health` before `authRequired` |
| Derived guard chain for the 160 upstream registrations | 153 exact; 7 differ only by `businessLicenseRequired` (see below) |
| `resolveAdminRoute` vs upstream `adminResource` | 81/81 same `key` and `matchedPrefix`, including `$staff` for `GET /admin/node/group/summary` and `$super` for the four `/admin/role` routes. No admin route resolves to `undefined`, which `adminPermissionGuard` turns into a 403 for every non-super-admin |
| Public routes vs `noAuthPathsRegex` | the 11 upstream-public registrations match; none of the other 149 do; the nine regexes match upstream's nine |

### Seven routes where `api_map.json` over-reports licensing

Hono's non-wildcard `use(path, mw)` is an exact-path match. The upstream bundle compiles a literal segment to `[^/]+`-style tokens and a trailing `*` to `(?:|/.*)` (`work/backend_bundle.ts.js:213864-213871`); the installed hono 4.13.13 behaves the same (`/admin/pay` fires for `/admin/pay`, not `/admin/pay/1`). Upstream and replica register the identical lines, so runtime behaviour matches — the annotation is what is wrong:

| Route | `api_map.json` | Actually wired (both sides) |
| --- | --- | --- |
| `PATCH`/`DELETE /admin/pay/:id`, `PATCH /admin/pay/:id/order` | `licenceGated` | `authRequired, adminRequired, adminPermissionGuard` |
| `PATCH /admin/plan/coupon/:id` | `licenceGated` | same |
| `PATCH /admin/topup/activity/:id` | `licenceGated` | same |
| `GET`/`POST /pay/:id/callback` | `licenceGated` + public | `authRequired` only (public via `^/pay/.*/callback`) |

Wiring evidence: `112__src__app.ts:63-73` vs `apps/backend/src/app.ts:130-140`. The test pins the set of seven and fails if it changes; a mutation of any one `use(...)` line fails two tests.

Not covered here: middleware registered inside route files (`zValidator`, per-handler `getRequestIP`) and the actual 401/403/402 responses. Those are exercised at the HTTP level by `tests/e2e/smoke.test.ts` and `scripts/e2e-local.sh`.

## Runtime checks the same day

- `GET /health` 200, `GET /plan` 200, `GET /admin/plan` 200, `GET /topup` 200 with the seeded admin key.
- Agent register: `handshake-node` / version `0.13.23` landed in `node`. The ack included `type: business`. The license body is plaintext, so the agent did not decrypt it (see `docs/DEVIATIONS.md`).
- `POST /api/tunnel/observer` 200 `{"ok":true}` and `POST /tunnel/observer` 400 on an empty body: the server entry strips the gateway `/api` prefix (see `docs/DEVIATIONS.md` item 19). Guards and route table are unchanged.

## Schema parity (automated, 2026-10-19)

`tests/unit/schema-parity.test.ts` parses `apps/backend/prisma/schema.prisma` and the decompiled `relayx-analysis/work/prisma_schema.prisma` and compares every field, then checks the generated Zod file against the replica's own schema.

| Check | Result |
| --- | --- |
| Models / enums | 23 / 18 on both sides, same names |
| Enum values | identical for all 18 |
| Fields | 297 total (241 scalar, 56 relation); same name, base type, `?`, `[]`, `@id`, `@unique`, `@default` on both sides — **0 differences** |
| Generated Zod | one schema per model; every scalar column present with the documented type mapping; `.nullable()` on exactly the 56 nullable scalar columns; no relation columns |
| Regression check | dropping one `.nullable()` in the generated file fails two cases; the field comparison fails on any added/removed/renamed column |

## Schema spot check (2026-10-17)

| Check | Result |
| --- | --- |
| Request export names vs `069__src__schemas__request.ts` | Same set, except upstream `TunnelChainSchema2` is `TunnelChainSchema` here (rename only) |
| Response export names vs `070__src__schemas__response.ts` | Same set (upstream `import_client19` is a bundler local, not a schema) |
| `ProtocolSchema` fields | Match `069:25-48`, including the `ss` method refine and the same Chinese message |
| `TunnelRequestSchema` omit + extend | Match `069:65-82` |
| Generated zod vs `schema.prisma` | 23 models, every scalar column present. Relations are intentionally omitted. Nullability was not re-checked column by column |

## Commission arithmetic

Referral credit is **not** in `services/commission.ts`. Both sides use that file for transfer and withdraw only (`transferToBalance`, `createWithdrawRequest`, `getWithdrawRequests`, `approveWithdraw`, `rejectWithdraw`). The payout is `TopupService.processReferralCommission` (`apps/backend/src/services/topup.ts:35-97`, original `037__src__services__topup.ts:11-66`).

Formula, both sides: `commissionAmount = amount * rate / 100`, skipped unless the license type is `business`, the buyer has `parent_id`, the rate is `parent.referral_commission_rate ?? passed rate ?? REFERRAL_COMMISSION_RATE`, and the amount is `> 0`. `REFERRAL_FIRST_ONLY` (parent override, else system config) skips the payout when the parent already has any `commission_log` row of type `referral`. That check is not unique, so two concurrent orders can both pay. The original has the same race. Default `REFERRAL_COMMISSION_RATE` is `0` and default `REFERRAL_MODE` is `"topup"` (`system_config.ts:28-30`).

Call sites match:

- Plan purchase pays only when `REFERRAL_MODE === "plan" && price > 0`, on `priceBeforeSetupFee` (setup fee excluded). `plan.ts:335-337` vs `038__src__services__plan.ts:295-297`.
- Topup notify and `markAsPaid` pay only when `REFERRAL_MODE === "topup"`, on `order.price` (bonus excluded). `pay.ts:133-134` vs `102__src__routes__pay.ts:116-117`.
- `settleTopupOrder` claims the pending row with `updateMany` before crediting `balance` by `price + bonus` and writing one `balance_log`. A second callback sees `success` and returns false. `topup-settlement.ts:12-51` vs `036:4-43`.

Live check, then config restored to those defaults: child user 14 was credited 100 (`balance_log` `admin_adjust`), subscribed plan 1 (price 10), and ended at balance 90 (`balance_log` `plan` −10). Parent user 13 `commission_balance` went 0 → 1 and `commission_log` recorded `(user 13, amount 1.0, type referral)`. Plan stock went 9 → 8.

One real miss, now fixed: upstream `062__src__middlewares__auth.ts:160-180` writes `parent_id` from the `ref` cookie when a cookie login creates the user. The replica created the row without it, so a normal signup could never earn commission. `middlewares/auth.ts` now does that lookup. Cookie signup itself was not exercised (no StackAuth project on this machine). Admin user create still does not take `parent_id`; the live check set it in SQLite.

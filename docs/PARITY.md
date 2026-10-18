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

- Guard parity (auth vs admin vs business license) was not re-derived route by route. Mount order in `apps/backend/src/app.ts` follows `112__src__app.ts`: `/queuedash` and `/health` before `authRequired`; `/admin/*` gets `adminRequired` and `adminPermissionGuard`.
- Zod nullability was not diffed for every schema. Field presence was.
- Aggregation SQL is covered by `tests/unit/date.test.ts` (the helper strings, plus a SQLite check that 2024-12-31 16:00:00Z buckets as 2025-01-01 / 2025-01 / 2025 in Asia/Shanghai).

## Runtime checks the same day

- `GET /health` 200, `GET /plan` 200, `GET /admin/plan` 200, `GET /topup` 200 with the seeded admin key.
- Agent register: `handshake-node` / version `0.13.23` landed in `node`. The ack included `type: business`. The license body is plaintext, so the agent did not decrypt it (see `docs/DEVIATIONS.md`).
- `POST /api/tunnel/observer` 200 `{"ok":true}` and `POST /tunnel/observer` 400 on an empty body: the server entry strips the gateway `/api` prefix (see `docs/DEVIATIONS.md` item 19). Guards and route table are unchanged.

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

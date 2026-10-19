# Verification

This is the verification contract for the replica. It records what is checked,
with which command, and what "green" looks like. `docs/PARITY.md` covers the
route/schema diff against the decompile; this file covers behaviour.

## TL;DR

```bash
bash scripts/verify.sh          # typecheck + unit + license + go vet/test + agent build
bash scripts/verify.sh --e2e    # same, then the live full-stack E2E
bash scripts/e2e-local.sh       # only the live E2E
```

Both scripts exit non-zero on the first failure and print the failing logs.
CI (`.github/workflows/ci.yml`) runs the same three groups: Node, Go, and the
live E2E.

## Automated checks

| Area | Command | Assertion |
| --- | --- | --- |
| Workspace types | `pnpm -r typecheck` | backend/shared/license-server `tsc --noEmit` exit 0 |
| Backend + shared units | `pnpm test` | Vitest suites (date, DNS, OpenVPN, license wire shapes, pay/coupon helpers, …) |
| License server | `pnpm --filter @relayx/license-server test` | Fernet wire compatibility with the Python reference, CLI, HTTP routes |
| Agent static | `cd apps/agent && go vet ./...` | no vet diagnostics |
| Agent units | `cd apps/agent && go test ./...` | forward, Shadowsocks, SOCKS5, relay/BIND, QUIC/TLS/WSS/MTCP, REALITY, mieru, WireGuard, OpenVPN, panel, gost config parsing, Fernet interop, CLI/config file, SOCKS address codec, self-signed TLS, mtcp/tls/mtls/wss/mwss/quic transports and session reuse, Socket.IO handshake/ack/ping/reconnect backoff, ICMP packet build, single-instance lock, system info counters, panel helpers, a full register→licence→config→listen session against a fake panel, REALITY short-id/key decoding, server-config defaults and a real REALITY handshake+echo against a local TLS 1.3 dest, protocol sniffing/replay/blocking, SOCKS5 request parsing, reply codes, admission, bypass and blocked protocols |
| Agent build | `pnpm agent:build` | `dist/relayx-agent --version` prints `relayx-agent version 0.13.23` |
| Tunnel availability | `vitest run tests/unit/tunnel-availability.test.ts` | plan requirement, traffic quota (plan and per-user), per-user `max_tunnels`, shared in/out node groups, and the recovered "empty group list is unrestricted" quirk |
| Route table parity | `vitest run tests/unit/route-table.test.ts` | 160 upstream registrations (157 distinct) all present; exactly the six documented extras; 163 replica paths |
| Admin guard behaviour | `vitest run tests/unit/admin-guards.test.ts` | super-admin bypass; business-licence gate; `$super` rejected, `$staff` open; read vs write by method; longest-prefix resource resolution; missing licence passes |
| Coupons and unpaid orders | `vitest run tests/unit/coupons-orders.test.ts` | coupon existence/cycle/validity/total-use/per-user gates, pending-only cancellation |
| System config and user bridge | `vitest run tests/unit/config-user.test.ts` | defaults vs stored JSON, null-as-absent, upsert, getConfigs backfill vs getAll asymmetry, StackAuth create/update payloads and guards |
| Roles and balance adjustments | `vitest run tests/unit/roles-balance.test.ts` | permission sanitising, role create/update/delete collisions and in-use guard, balance/commission increments with admin logs, negative rollback, log filters |
| DNS orchestration | `vitest run tests/unit/dns-orchestration.test.ts` | provider CRUD/filters/cascade delete, in-group validation and custom lines, owner-scoped update/delete, record pairing in syncIpSet |
| Commission wallet + withdrawals | `vitest run tests/unit/withdraw.test.ts` | withdraw creation debit/log/ticket, min amount/method/balance gates, approve vs reject refund, transfer between wallets with both logs, admin filters |
| Ticket service | `vitest run tests/unit/tickets.test.ts` | create/list/thread ownership, status updates, user and admin replies with notification payloads, telegram routing by ownership/super-admin |
| Node and node-group services | `vitest run tests/unit/node-groups.test.ts` | port-range parsing quirks, group create/update ordering and owner scoping, plan-based group visibility (all-in, explicit list, custom), out-group allow-list, node id uniqueness, liveness window, scoped cascade delete |
| Tunnel writes and queries | `vitest run tests/unit/tunnel-create.test.ts` | createTunnel insert/chains/order_by, per-user cap, port conflict/range, out-group and protocol gates, wireguard preparation; getTunnels scoping, filters, pagination, sorting, chain filter; listen-protocol defaults/reuse |
| Route error payloads | `vitest run tests/unit/route-errors.test.ts` | in-process app: 401 bearer shape, 403 Forbidden, zod 400 body, 409 catch-all on payment delete, 404 unknown path |
| Subscriptions | `vitest run tests/unit/tunnel-subscription.test.ts` | plan/expiry/traffic gates, ss lines and site intro, ordering, vless/wg/mieru share links, Clash proxies with deduped names |
| Tunnel config generation | `vitest run tests/unit/tunnel-config.test.ts` | in-node document: tls/observer header, tcp+udp service pair, forwarder weight order, WAIT_LISTEN, listen-protocol handlers, limits, bypass/admission, remote-forward relay, udp-only and wireguard services, out-node WAIT_LISTEN services, chain hops, IP/limit/protocol helpers |
| Stats aggregates | `vitest run tests/unit/stats.test.ts` | throwaway SQLite: overview counts, Shanghai day/month/year bucketing around midnight, traffic sums and node-group filter, live-today Redis append only for day buckets |
| Plan purchase | `vitest run tests/unit/plan-purchase.test.ts` | throwaway SQLite: debit/order/log/user-plan/stock, coupon, setup-fee waiver, balance/stock/status/renewable gates, plan-mode referral on the pre-fee amount, lifetime traffic |
| Topup settlement + referral | `vitest run tests/unit/topup-settlement.test.ts` | throwaway SQLite: single credit on settle, replay returns false, mismatched snapshot 409, referral rate/first-only/licence/parent gates |
| Plan pricing | `vitest run tests/unit/plan-pricing.test.ts` | percentage/fixed coupons, zero clamp, setup fee order and same-plan waiver, commission base |
| Payment helpers | `vitest run tests/unit/pay.test.ts` | amount parsing, fee order/rounding, signing string and md5/JSON-Base64 vectors, order validation, gateway construction and dispatch |
| Response schema parity | `vitest run tests/unit/route-response-schemas.test.ts` | 64 routed responses declare the same schema expression as the decompile (`exports_external`/`resolver` aliases normalised) |
| Route documentation parity | `vitest run tests/unit/route-docs.test.ts` | describeRoute presence, summaries, status codes and response descriptions identical to the decompile for all 160 registrations |
| Route validator parity | `vitest run tests/unit/route-validators.test.ts` | all 160 upstream registrations found with identical `json`/`query`/`param` validator targets |
| Schema parity | `vitest run tests/unit/schema-parity.test.ts` | 23 models / 18 enums / 297 fields identical to the decompiled schema; generated Zod covers every scalar column with matching nullability |
| Guard parity | `vitest run tests/unit/route-guards.test.ts` | upstream `use(...)` chain reproduced in order; 160/160 routes derive it (7 documented api-map exceptions); 81/81 admin keys; 11 public routes and 9 bypass regexes exact |

Latest observed run (2026-10-19, Node 24.22.0 / pnpm 11.7.0 / Go 1.27.1):

- `pnpm -r typecheck` — exit 0
- `pnpm test` — 34 files, 363 passed (the live smoke case self-skips when the backend is down)
- `pnpm --filter @relayx/license-server test` — 6 files, 44 passed
- `go vet ./...`, `go test ./...` — clean
- `scripts/e2e-local.sh` — PASS

## Live full-stack E2E (`scripts/e2e-local.sh`)

The script owns the whole stack and cleans up after itself. It uses:

| Component | Default | Override |
| --- | --- | --- |
| Backend | `127.0.0.1:3000` | `BACKEND_PORT` |
| License server | `127.0.0.1:3100` | `LICENSE_PORT` |
| Tunnel listen | `127.0.0.1:18080` | `E2E_LISTEN_PORT` |
| Echo target | `127.0.0.1:19081` | `E2E_ECHO_PORT` |
| SQLite database | `apps/backend/prisma/e2e.db` | `DATABASE_URL` |
| Work dir | `.e2e/` (gitignored) | `E2E_KEEP=1` keeps it |

Steps and assertions:

1. **License** — `issue --type business` for `http://127.0.0.1:<backend port>` into a throwaway `license.db`; the license server must answer `GET /health`.
2. **Database** — `db:reset` + `seed` with the deterministic admin key; fixtures insert the minimum world the tunnel exporter accepts: an `e2e-plan`, the admin's unexpired `UserPlan`, an `in` node group (`allow_listen_protocol`), and one TCP port-forward tunnel. Without the plan, `filterAvailableTunnels` (`apps/backend/src/services/tunnel.ts:915`) silently exports `0 service(s)` — the fixtures exist to catch exactly that.
3. **Config push** — the agent must log `license accepted`, `config received (fernet): 2 service(s)` (the panel emits `tcp-` and `udp-` for a non-UDP forward), and `config applied: 2/2`.
4. **TCP data plane** — a client writing `e2e-probe` to the tunnel port must read `pong:e2e-probe` from the echo target.
5. **Observer path** — the agent's 5s observer loop must reach the backend through the deployment `/api` prefix: backend access log contains `"url":"/tunnel/observer"`, and the agent log has no `observer post … 401`.
6. **OpenAPI document** — `GET /openapi.json` returns 200; `/bot` publishes the raw JSON object and `/tunnel/observer`, `/admin/plan/coupon/{id}`, `/user/info` are present.
7. **Traffic accounting** — a manual `POST /api/tunnel/observer` carrying 2 MiB in + 2 MiB out must increase `Tunnel.traffic` and `UserPlan.traffic_used` by `4 MiB / 1024³ = 0.00390625` GiB (exact float comparison within `1e-9`).

The fixture/check command is `apps/backend/scripts/e2e-fixtures.ts`:

```bash
cd apps/backend
DATABASE_URL="file:./e2e.db" pnpm exec tsx scripts/e2e-fixtures.ts setup
DATABASE_URL="file:./e2e.db" pnpm exec tsx scripts/e2e-fixtures.ts traffic
```

## What is intentionally not covered

These need hardware, external accounts or a deployment layer that this repo
does not include:

- **Live DNS providers** — Cloudflare/Huawei clients are exercised against mocks only (`tests/unit/dns.test.ts`).
- **Kernel WireGuard** — the userspace device is tested in-process; the `wg`/`ip` path needs the kernel module.
- **OpenVPN TUN traffic** — the control channel, key method 2 and `PUSH_REPLY` are tested with the official OpenVPN 2.6 client, but this container has no `CAP_NET_ADMIN`, so the client stops at `TUNSETIFF`.
- **StackAuth cookie login** — no StackAuth project is configured; the `ref` cookie `parent_id` fix was checked at the service level.
- **Telegram bot transport** — no bot token; startup logs the skip line.
- **BullMQ with Redis** — the server boots without Redis and `/queuedash` reports `connected: false`.
- **Docker/Compose deployment** — no Docker daemon here; the license-server Dockerfile was not built.
- **h2/h3/http3, obfs4, vmess, tun handlers** — these are not in the upstream agent's gost registry (`relayx-analysis/reports/AGENT_SERVICE.md` §3 lists exactly 10 handlers and 15 listeners), so the panel cannot produce such services. The agent reports them as `listen_error` stubs; see `docs/AGENT.md`.

## Reproducing the live checks by hand

If you want the pieces rather than the harness:

```bash
pnpm install && pnpm db:generate && pnpm db:push && pnpm seed
pnpm --filter @relayx/license-server start &            # :3100
pnpm start &                                            # :3000
RELAYX_BASE_URL=http://127.0.0.1:3000 \
RELAYX_API_KEY=a34d563e-9efe-4047-9e20-05a9678ef5fb \
  pnpm test:e2e
```

The smoke test skips when nothing is listening on `RELAYX_BASE_URL`, which is
why `pnpm test` is safe to run with no stack.

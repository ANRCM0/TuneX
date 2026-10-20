# Coverage and acceptance index

This file maps every layer of the replica to the suite that verifies it, and
lists what is deliberately **not** covered. `docs/VERIFY.md` is the verification
contract (commands and expected greens); this file is the index for "is this
part of the replication actually checked?".

## How to run

```bash
bash scripts/verify.sh          # typecheck, unit, license, go vet/test, agent build
bash scripts/verify.sh --e2e    # plus the live full-stack E2E
bash scripts/e2e-local.sh       # only the live E2E
npx vitest run tests/unit/<file>.test.ts   # one suite
cd apps/agent && go test ./... -cover      # Go suites with coverage
```

## Suite inventory

| Suite                          | Count                    | Notes                                                                                                                                                                     |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace vitest (`pnpm test`) | 60 files / 534 tests     | 36 unit files (incl. 5 web suites + local auth), 6 license-server files, 1 live smoke that self-skips when the backend is down                                            |
| License server (dedicated run) | 6 files / 44 tests       | Fernet wire compatibility, CLI, HTTP routes, store                                                                                                                        |
| Go (`go test ./...`)           | 33 packages, all covered | table below                                                                                                                                                               |
| Live E2E                       | 1                        | license → config push → TCP forward → observer → exact traffic accounting → OpenAPI document → **web console** (gate → sign-up → mailed-token verify → `/api` round-trip) |

## Backend: API surface

| Concern                                                            | Suite                                         |
| ------------------------------------------------------------------ | --------------------------------------------- |
| 160 upstream registrations present, exactly 6 documented extras    | `tests/unit/route-table.test.ts`              |
| Guard chain per route (and 7 documented `api_map` mis-annotations) | `tests/unit/route-guards.test.ts`             |
| `zValidator` targets per route                                     | `tests/unit/route-validators.test.ts`         |
| `describeRoute` presence, summaries, status codes, descriptions    | `tests/unit/route-docs.test.ts`               |
| Response schema expressions                                        | `tests/unit/route-response-schemas.test.ts`   |
| Prisma schema vs decompile, column by column; generated Zod drift  | `tests/unit/schema-parity.test.ts`            |
| Runtime OpenAPI document and error payloads (401/403/400/409/404)  | `tests/unit/route-errors.test.ts`, E2E step 6 |
| Subscriptions (share URLs, Clash)                                  | `tests/unit/tunnel-subscription.test.ts`      |
| In/out node gost documents                                         | `tests/unit/tunnel-config.test.ts`            |
| Tunnel write path, queries, protocol preparation                   | `tests/unit/tunnel-create.test.ts`            |

## Backend: money path

| Concern                                                                | Suite                                    |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| Plan price rule (coupon, clamp, setup fee, commission base)            | `tests/unit/plan-pricing.test.ts`        |
| Plan purchase end to end (balance, order, user plan, stock, referral)  | `tests/unit/plan-purchase.test.ts`       |
| Callback short-circuit, stacked bonus, renewal scan, observer rate sum | `tests/unit/money-gaps.test.ts`          |
| Topup settlement idempotency and referral payout                       | `tests/unit/topup-settlement.test.ts`    |
| Commission wallet, withdrawals, transfers                              | `tests/unit/withdraw.test.ts`            |
| Balance/commission admin adjustments and logs                          | `tests/unit/roles-balance.test.ts`       |
| Stats aggregates, timezone bucketing, live traffic                     | `tests/unit/stats.test.ts`               |
| Payment helpers (fees, signing vectors, gateways)                      | `tests/unit/pay.test.ts`                 |
| Coupons and unpaid orders                                              | `tests/unit/coupons-orders.test.ts`      |
| Tunnel availability quota rules                                        | `tests/unit/tunnel-availability.test.ts` |

## Backend: operations surfaces

| Concern                                                               | Suite                                   |
| --------------------------------------------------------------------- | --------------------------------------- |
| Nodes, node groups, plan-based visibility, port ranges                | `tests/unit/node-groups.test.ts`        |
| DNS provider CRUD + in-group keep-alive + record pairing              | `tests/unit/dns-orchestration.test.ts`  |
| Tickets (ownership, replies, Telegram routing)                        | `tests/unit/tickets.test.ts`            |
| Roles (permission sanitising, in-use guard)                           | `tests/unit/roles-balance.test.ts`      |
| System config (defaults, upsert, `getAllConfigs` asymmetry)           | `tests/unit/config-user.test.ts`        |
| Production `CONFIG_SECRET` guard                                      | `tests/unit/config-secret.test.ts`      |
| In-memory Redis (expiry, hashes, pub/sub, pipeline, lock)             | `tests/unit/redis-memory.test.ts`       |
| StackAuth user bridge                                                 | `tests/unit/config-user.test.ts`        |
| License client (cache, refresh, error mapping)                        | `tests/unit/license-client.test.ts`     |
| Email transports (SMTP fake, Resend)                                  | `tests/unit/email-service.test.ts`      |
| Notification channels, rendering, business messages                   | `tests/unit/notify.test.ts`             |
| Telegram API and StackAuth REST clients                               | `tests/unit/telegram-stackauth.test.ts` |
| Admin guards behaviour (`$super`/`$staff`, read/write)                | `tests/unit/admin-guards.test.ts`       |
| Local cron runner when Redis is unset                                 | `tests/unit/local-scheduler.test.ts`    |
| Redis-backed lock (SET NX PX)                                         | `tests/unit/redis-lock.test.ts`         |
| Health probes, sysinfo heartbeat, topup creation, observer node stats | `tests/unit/ops-gaps.test.ts`           |
| Socket register rejection, register block, `listen_error`             | `tests/unit/socket-handlers.test.ts`    |

## Operations and integrations (productization)

| Concern                                                                       | Suite                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| Migration baseline, MySQL variant generation, drift (`prisma migrate diff`)   | `tests/unit/migrations.test.ts`                      |
| Aggregate SQL dialect switch + "call sites never hand-write SQL" guard        | `tests/unit/date.test.ts`, `tests/unit/aggregate-dialect.test.ts` |
| MySQL HTTP surface for the aggregates (CI, real `mysql:8.0`)                  | `apps/backend/scripts/mysql-endpoints-smoke.mjs`     |
| Rate-limit windows per IP/account, 429 + `Retry-After`, window reset, lockout | `tests/unit/rate-limit.test.ts`                      |
| Prometheus registry, label escaping, histogram buckets, `/metrics` gating     | `tests/unit/metrics.test.ts`                         |
| Cloudflare DNS over loopback HTTP: zone lookup, list, create, patch, delete   | `tests/integration/cloudflare-dns.test.ts`           |
| Huawei DNS over loopback HTTP incl. SDK-HMAC-SHA256 signature recomputation   | `tests/integration/huawei-dns.test.ts`               |
| Telegram Bot API: URL/token placement, JSON body, `ok:false` error text       | `tests/integration/telegram.test.ts`                 |
| Coverage gate (ratchet) and Prettier check                                    | `pnpm test:coverage`, `pnpm lint` (CI + `verify.sh`) |

## Web console (`apps/web`)

| Concern                                                                                                                                              | Suite                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| RBAC mirror: personal licence blanks the surface, `canRead/canWrite/isStaff`, 19 resources, URL resolution                                           | `tests/unit/web-permissions.test.ts`    |
| Per-protocol share links (8 protocols), wireguard `.conf`, openvpn `.ovpn`, guard rails                                                              | `tests/unit/web-tunnel-share.test.ts`   |
| Install command flag order/spelling, multi-IP, upgrade/uninstall                                                                                     | `tests/unit/web-deploy-command.test.ts` |
| Route manifest ↔ file tree, admin nesting                                                                                                           | `tests/unit/web-routes.test.ts`         |
| Live console: gate, sign-up through the proxy, verify, `/api` round-trip                                                                             | `scripts/e2e-local.sh` (web stage)      |
| Local auth: scrypt hashes, HS256 tokens, cookie shape, sign-up/sign-in/guards, mailed verification token (send, throttle, expiry, direct-mode guard) | `tests/unit/local-auth.test.ts`         |
| i18n: every key resolves, no duplicate keys, `en` refines known keys, no hard-coded Chinese                                                          | `tests/unit/web-i18n.test.ts`           |
| Production build (Next standalone)                                                                                                                   | `scripts/verify.sh` step `web build`    |

The suites above cover pure logic. Interaction-heavy pieces (calendar filters, the mobile
action sheet, the chain editor, the landing canvas) are exercised by the manual route smoke in
`docs/VERIFY.md`; there is no DOM test runner in this workspace.

Not covered: real StackAuth sessions (`/handler/[...stack]` is out of scope), browser
rendering/DOM, and the live `/api` proxy (the E2E harness starts the backend, not the web app).

## Agent: protocol and runtime

| Area                                                                                                                                   | Suite                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Config document parsing, accessors, targets/chain resolution                                                                           | `internal/gostcfg` (`parse_test.go` + balance/observer tests)           |
| Manager dispatch, port conflicts/retry, stubs, reconciliation                                                                          | `internal/service` (`dispatch_test.go`, `ports_test.go`, manager tests) |
| TCP forward, Shadowsocks TCP/UDP, SOCKS5, relay CONNECT/BIND, WireGuard, OpenVPN, mieru, VLESS/REALITY, QUIC, TLS/mTLS, WSS/MWSS, MTCP | per-package Go tests (table below)                                      |
| Control plane: register → license → fernet config → listener report                                                                    | `internal/panel/session_test.go` (fake panel) + live E2E                |
| Socket.IO protocol, ack/ping/reconnect backoff                                                                                         | `internal/socketio`                                                     |
| Fernet interop with the panel's npm package (vectors)                                                                                  | `internal/fernet`                                                       |
| CLI/config surface, single instance, pprof, version/help                                                                               | `internal/config`, `internal/lockfile`, `cmd/relayx-agent`              |

### Go package coverage

| Package             | Cover | Package            | Cover |
| ------------------- | ----- | ------------------ | ----- |
| `socksaddr`, `logx` | 100%  | `sniff`            | 98.0% |
| `lockfile`          | 92.9% | `observe`          | 91.3% |
| `fernet`            | 91.0% | `selfsign`         | 87.5% |
| `config`            | 84.0% | `sysinfo`          | 83.2% |
| `openvpn`           | 82.6% | `socketio`         | 79.2% |
| `httpproxy`         | 77.8% | `mtcp`             | 76.8% |
| `vless`             | 76.7% | `realityx`         | 76.4% |
| `wstun`             | 75.6% | `relayx`           | 75.2% |
| `tlstun`            | 74.7% | `limit`            | 73.9% |
| `relay`             | 73.4% | `forward`          | 71.1% |
| `bypass`            | 70.4% | `admit`            | 70.2% |
| `ping`              | 69.7% |
| `mierux`            | 88.5% | `quicx`            | 75.6% |
| `shadowsocks`       | 68.5% | `service`          | 65.2% |
| `gostcfg`           | 73.4% | `wireguard`        | 59.2% |
| `socks5`            | 64.2% | `cmd/relayx-agent` | 52.1% |
| `panel`             | 66.6% |                    |       |

## Deliberately not covered

These need hardware, credentials or a deployment layer this repo does not own.
They are also listed in `docs/VERIFY.md`.

- **Live DNS providers** — the Cloudflare/Huawei clients are tested against mocks
  and the orchestration against SQLite; no accounts exist here.
- **StackAuth / Telegram / Redis / BullMQ** — the clients and message rendering
  are covered with stubs; the real hosted services, long-polling and workers are
  not exercised.
- **Kernel WireGuard and OpenVPN TUN** — the userspace WireGuard device and the
  OpenVPN control/data channel are tested; this container has no
  `CAP_NET_ADMIN`, so no kernel interface or TUN traffic.
- **Docker/Compose build** — no daemon here.
- **`api_map` disagreements** — where the decompile annotation and the Hono
  runtime differ (seven `licenceGated` routes, an empty group list in the
  tunnel filter), the tests assert the runtime behaviour and the discrepancy is
  recorded in `docs/PARITY.md`.

## Keeping this honest

Every suite in the tables above was mutation-checked while it was written: a
deliberate change to the wiring, a status code, a `.nullable()`, a quota rule or
a guard branch makes at least one case fail. Counts and commands live in
`docs/VERIFY.md`; if a suite is added or removed, update both files.

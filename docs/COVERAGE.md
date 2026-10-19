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

| Suite | Count | Notes |
| --- | --- | --- |
| Workspace vitest (`pnpm test`) | 39 files / 407 tests | 31 unit files, 6 license-server files, 1 live smoke that self-skips when the backend is down |
| License server (dedicated run) | 6 files / 44 tests | Fernet wire compatibility, CLI, HTTP routes, store |
| Go (`go test ./...`) | 33 packages, all covered | table below |
| Live E2E | 1 | license → config push → TCP forward → observer → exact traffic accounting → OpenAPI document |

## Backend: API surface

| Concern | Suite |
| --- | --- |
| 160 upstream registrations present, exactly 6 documented extras | `tests/unit/route-table.test.ts` |
| Guard chain per route (and 7 documented `api_map` mis-annotations) | `tests/unit/route-guards.test.ts` |
| `zValidator` targets per route | `tests/unit/route-validators.test.ts` |
| `describeRoute` presence, summaries, status codes, descriptions | `tests/unit/route-docs.test.ts` |
| Response schema expressions | `tests/unit/route-response-schemas.test.ts` |
| Prisma schema vs decompile, column by column; generated Zod drift | `tests/unit/schema-parity.test.ts` |
| Runtime OpenAPI document and error payloads (401/403/400/409/404) | `tests/unit/route-errors.test.ts`, E2E step 6 |
| Subscriptions (share URLs, Clash) | `tests/unit/tunnel-subscription.test.ts` |
| In/out node gost documents | `tests/unit/tunnel-config.test.ts` |
| Tunnel write path, queries, protocol preparation | `tests/unit/tunnel-create.test.ts` |

## Backend: money path

| Concern | Suite |
| --- | --- |
| Plan price rule (coupon, clamp, setup fee, commission base) | `tests/unit/plan-pricing.test.ts` |
| Plan purchase end to end (balance, order, user plan, stock, referral) | `tests/unit/plan-purchase.test.ts` |
| Topup settlement idempotency and referral payout | `tests/unit/topup-settlement.test.ts` |
| Commission wallet, withdrawals, transfers | `tests/unit/withdraw.test.ts` |
| Balance/commission admin adjustments and logs | `tests/unit/roles-balance.test.ts` |
| Stats aggregates, timezone bucketing, live traffic | `tests/unit/stats.test.ts` |
| Payment helpers (fees, signing vectors, gateways) | `tests/unit/pay.test.ts` |
| Coupons and unpaid orders | `tests/unit/coupons-orders.test.ts` |
| Tunnel availability quota rules | `tests/unit/tunnel-availability.test.ts` |

## Backend: operations surfaces

| Concern | Suite |
| --- | --- |
| Nodes, node groups, plan-based visibility, port ranges | `tests/unit/node-groups.test.ts` |
| DNS provider CRUD + in-group keep-alive + record pairing | `tests/unit/dns-orchestration.test.ts` |
| Tickets (ownership, replies, Telegram routing) | `tests/unit/tickets.test.ts` |
| Roles (permission sanitising, in-use guard) | `tests/unit/roles-balance.test.ts` |
| System config (defaults, upsert, `getAllConfigs` asymmetry) | `tests/unit/config-user.test.ts` |
| In-memory Redis (expiry, hashes, pub/sub, pipeline, lock) | `tests/unit/redis-memory.test.ts` |
| StackAuth user bridge | `tests/unit/config-user.test.ts` |
| License client (cache, refresh, error mapping) | `tests/unit/license-client.test.ts` |
| Email transports (SMTP fake, Resend) | `tests/unit/email-service.test.ts` |
| Notification channels, rendering, business messages | `tests/unit/notify.test.ts` |
| Telegram API and StackAuth REST clients | `tests/unit/telegram-stackauth.test.ts` |
| Admin guards behaviour (`$super`/`$staff`, read/write) | `tests/unit/admin-guards.test.ts` |

## Agent: protocol and runtime

| Area | Suite |
| --- | --- |
| Config document parsing, accessors, targets/chain resolution | `internal/gostcfg` (`parse_test.go` + balance/observer tests) |
| Manager dispatch for every listener the panel emits, stubs, reconciliation | `internal/service` (`dispatch_test.go` + manager tests) |
| TCP forward, Shadowsocks TCP/UDP, SOCKS5, relay CONNECT/BIND, WireGuard, OpenVPN, mieru, VLESS/REALITY, QUIC, TLS/mTLS, WSS/MWSS, MTCP | per-package Go tests (table below) |
| Control plane: register → license → fernet config → listener report | `internal/panel/session_test.go` (fake panel) + live E2E |
| Socket.IO protocol, ack/ping/reconnect backoff | `internal/socketio` |
| Fernet interop with the panel's npm package (vectors) | `internal/fernet` |
| CLI/config surface, single instance, pprof, version/help | `internal/config`, `internal/lockfile`, `cmd/relayx-agent` |

### Go package coverage

| Package | Cover | Package | Cover |
| --- | --- | --- | --- |
| `socksaddr`, `logx` | 100% | `sniff` | 98.0% |
| `lockfile` | 92.9% | `observe` | 91.3% |
| `fernet` | 91.0% | `selfsign` | 87.5% |
| `config` | 84.0% | `sysinfo` | 83.2% |
| `openvpn` | 82.6% | `socketio` | 79.2% |
| `httpproxy` | 77.8% | `mtcp` | 76.8% |
| `vless` | 76.7% | `realityx` | 76.4% |
| `wstun` | 75.6% | `relayx` | 75.2% |
| `tlstun` | 74.7% | `limit` | 73.9% |
| `relay` | 73.4% | `forward` | 71.1% |
| `bypass` | 70.4% | `admit` | 70.2% |
| `ping`, `mierux` | 69.7% | `quicx` | 68.9% |
| `shadowsocks` | 68.5% | `service` | 64.1% |
| `gostcfg` | 73.4% | `wireguard` | 55.7% |
| `socks5` | 61.4% | `cmd/relayx-agent` | 52.1% |
| `panel` | 60.7% | | |

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

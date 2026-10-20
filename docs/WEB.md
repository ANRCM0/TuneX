# The web console (`apps/web`)

The panel UI reconstructed from the shipped `relayx/web:latest` image. Everything here is
derived from the reverse-engineering evidence in `relayx-analysis/` — see
`relayx-web/reports/` for the per-layer findings (routes, API client, auth, design system,
build/security, flows, columns, landing page) and `relayx-web/artifacts/` for the
machine-readable extracts.

## Stack

| Layer                | Choice                                                                           | Upstream evidence                                                       |
| -------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Framework            | Next.js 16.3.5 App Router, `output: "standalone"`, Turbopack                     | `required-server-files.json`                                            |
| UI                   | React 19.2.8 + Tailwind v4 + shadcn-style primitives (copied, not a runtime dep) | `package.json`, CSS chunk                                               |
| Data                 | SWR + a Hono-RPC-style client (`src/lib/client.ts`)                              | module 194108                                                           |
| Tables               | `@tanstack/react-table` + the shared `DataTable`                                 | module 493843                                                           |
| URL state            | nuqs (`page` / `perPage` / `sort` + column filters)                              | pages                                                                   |
| i18n                 | own runtime, zh-CN default + curated `en`                                        | 6,068 literals → 2,2xx keys                                             |
| Charts / editor / QR | recharts, `@uiw/react-md-editor`, `react-qr-code`, `@dnd-kit`                    | 5 chart surfaces, 3 Markdown surfaces, 2 QR surfaces, 6 draggable lists |
| Dates                | `date-fns` 4 + `react-day-picker` 8.10.1 (Popover calendar, single + range)      | filter variants `date` / `dateRange`                                    |

## How a request flows

```
browser ──same-origin──> web:3000 (Next)
                          │ rewrites: /api/:path* → BACKEND_ORIGIN/:path*
                          │           /socket.io  → BACKEND_ORIGIN/socket.io
                          │           /openapi.json, /docs → backend
                          └ everything else → App Router (43 routes)
```

- `BACKEND_ORIGIN` defaults to `http://127.0.0.1:3000` so the console can run next to
  `pnpm dev`; compose sets `http://backend:3000`.
- The browser never talks to the backend directly — same model as upstream, where the
  rewrite target is the compose service name `relayx`.

## Authentication and authorisation

Two modes, selected by the backend's `AUTH_MODE` (default `local` when no StackAuth project
is configured):

| Mode              | Identity                                                     | Panel behaviour                                                                                      |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `local` (default) | `LocalCredential` rows: scrypt password hash + HS256 session | `/handler/sign-in`, `/handler/sign-up`, `/handler/sign-out`, `/verify-email` call `POST /api/auth/*` |
| `stack`           | StackAuth project (upstream)                                 | the same pages should delegate to the hosted handler; the gate is unchanged                          |

How the pieces fit:

- `src/app/handler/[...stack]/page.tsx` renders the four auth pages. Sign-up and sign-in
  post to `/api/auth/sign-in|sign-up`; the backend answers with the `stack-access` cookie
  (a percent-encoded `[refresh, access]` pair) and the page routes onward.
- Email verification: the verify card posts to `/api/auth/verify-email/request`, which mails a
  one-time link (`{SITE_URL}/handler/verify-email?token=…`) through the backend's `EmailService`.
  The page verifies automatically when it lands with `?token=`; without a mail transport the
  endpoint returns the link so the flow still completes. `AUTH_VERIFY_MODE=direct` keeps the
  old "mark from the session" behaviour; `email` (the default) refuses that shortcut.
- `src/proxy.ts` is the Next 16 server gate (formerly middleware). It asks the backend
  `GET /auth/me` with the incoming cookie, then applies the upstream rules: `/` and
  `/handler/*` pass; no session → `/handler/sign-in` (carrying `?ref`); verified user on
  `/verify-email` → `/home`; unverified user anywhere else → `/verify-email`.
- The gate only covers "signed in" and "email verified". **RBAC and the business licence are
  enforced by the backend** (`adminPermissionGuard`, `businessLicenseRequired`); the console
  mirrors them with `effectiveAccess()` from `@relayx/shared/permissions`.
- `DEV_BYPASS_AUTH=1` makes the gate treat every visitor as verified — useful for UI work
  without the backend, never for a deployment.

End-to-end (both processes running):

```bash
pid=$!                       # backend on :3000 with AUTH_MODE=local
curl -c /tmp/jar -X POST localhost:3001/api/auth/sign-up \
  -H 'content-type: application/json' -d '{"email":"me@example.com","password":"supersecret"}'
curl -b /tmp/jar -o /dev/null -w '%{http_code}\n' localhost:3001/verify-email   # 200
curl -b /tmp/jar -X POST localhost:3001/api/auth/verify-email
curl -b /tmp/jar -o /dev/null -w '%{http_code}\n' localhost:3001/home          # 200
```

## i18n

- `src/lib/i18n/zh-CN.ts` — 2,2xx keys / 59 areas, each key `<slug>_<sha1(text)[:6]>` so the
  same Chinese sentence always maps to one key. Provenance is recorded in
  `relayx-web/artifacts/i18n-zh-CN.json` (upstream literals vs. authoring added by this port).
- `src/lib/i18n/en.ts` — curated English (navigation, titles, table scaffolding, actions,
  all enum values). Missing keys fall back to Chinese, never to a raw id.
- `src/lib/i18n/index.ts` — `t()`, `tf()` (placeholder substitution), `tEnum()` (the 19
  recovered enum tables), locale store + `useSyncExternalStore` subscription.
- The invariant "no hard-coded Chinese outside the dictionary, comments and the five
  backend-error regexes" is a unit test (`tests/unit/web-i18n.test.ts`).

## Tests

```bash
npx vitest run tests/unit/web-*.test.ts       # i18n integrity, RBAC helpers, share links, deploy command, route manifest
pnpm --filter @relayx/web typecheck
pnpm --filter @relayx/web build
```

The suites deliberately cover the parts that are pure logic:

| Suite                        | What it pins                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `web-permissions.test.ts`    | personal licence blanks the admin surface; `canRead/canWrite/isStaff`; 19 resources; URL resolution                   |
| `web-tunnel-share.test.ts`   | the 8 per-protocol share strings, wireguard `.conf`, openvpn `.ovpn`, guard rails                                     |
| `web-deploy-command.test.ts` | install-command flag order/spelling, multi-IP expansion, upgrade/uninstall                                            |
| `web-routes.test.ts`         | `apps/web/routes.json` matches the file tree; admin routes live under `(main)`; `/handler` documented as out of scope |
| `web-i18n.test.ts`           | every `t()` key exists, no duplicate keys, `en` only refines known keys, no hard-coded Chinese                        |

## Interaction details worth knowing

- **Multi-hop chains** — the tunnel form edits `tunnel_chains: [{node_type:"in"|"out", node_group_id}]`;
  the hop list is ordered and each hop is priced independently by the backend. Node groups are
  loaded from `GET /node/group` when the dialog opens.
- **Mobile rows** — below 768px the tunnel table renders cards and every row opens a bottom
  sheet with the five upstream actions (配置 / 编辑 / 测试 / 停用 / 删除).
- **Traffic quota** — `/home` shows a `Progress` bar from `user_plan.traffic_used` against the
  plan cap.
- **Landing canvas** — the topology animation is masked by the same radial vignette upstream
  draws over it, so the copy stays readable.

## Deviations from upstream

Recorded in `docs/DEVIATIONS.md` (web section) and in `relayx-web/reports/13-frontend-build.md`:
error handling guards non-JSON responses, SWR keys come from exported builders, admin hooks
are renamed, list pages opt out of prerender, and the StackAuth SDK is replaced by an adapter.

#!/usr/bin/env bash
#
# Deterministic full-stack E2E for the RelayX replica.
#
# It starts a private license server, the backend against a throwaway SQLite
# database, a TCP echo target, and the Go agent, then proves the whole data
# plane:
#
#   1. `POST /tunnel`-equivalent fixtures export 2 services (tcp + udp) to the
#      agent, which decrypts the Fernet config and listens (config applied 2/2);
#   2. a TCP client on the tunnel port reaches the echo target through the
#      agent ("pong:<payload>");
#   3. the agent's 5s observer loop reaches the panel through the deployment
#      `/api` prefix (backend access log shows POST /tunnel/observer);
#   4. a manual observer event with known bytes increments `Tunnel.traffic`
#      and `UserPlan.traffic_used` by the expected GiB amount;
#   5. the web console serves the same origin: anonymous /home redirects to
#      /handler/sign-in, sign-up through the `/api` proxy issues the session
#      cookie, and after verification /home returns 200 with real user data.
#
# Everything it creates lives under .e2e/ (gitignored) and is removed on exit
# unless E2E_KEEP=1. The ports must be free: backend 3000, license 3100, tunnel
# listen 18080, echo 19081 (override with BACKEND_PORT, LICENSE_PORT,
# E2E_LISTEN_PORT, E2E_ECHO_PORT).
#
# Usage:
#   bash scripts/e2e-local.sh          # build agent if missing
#   E2E_REBUILD=1 bash scripts/e2e-local.sh
#   E2E_KEEP=1 bash scripts/e2e-local.sh   # keep .e2e/ logs and databases
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKEND_PORT="${BACKEND_PORT:-3000}"
LICENSE_PORT="${LICENSE_PORT:-3100}"
E2E_LISTEN_PORT="${E2E_LISTEN_PORT:-18080}"
E2E_ECHO_PORT="${E2E_ECHO_PORT:-19081}"
WEB_PORT="${WEB_PORT:-3001}"
SITE_URL="http://127.0.0.1:${BACKEND_PORT}"
WEB_URL="http://127.0.0.1:${WEB_PORT}"
LICENSE_URL="http://127.0.0.1:${LICENSE_PORT}"
DATABASE_URL="${DATABASE_URL:-file:./e2e.db}"
E2E_TOKEN="${E2E_TOKEN:-e2e-node-group-token}"
E2E_ADMIN_API_KEY="${E2E_ADMIN_API_KEY:-e2e-admin-api-key}"
SEED_ADMIN_API_KEY="$E2E_ADMIN_API_KEY"
export DATABASE_URL E2E_TOKEN E2E_LISTEN_PORT E2E_ECHO_PORT SEED_ADMIN_API_KEY

WORK_DIR="$ROOT/.e2e"
LICENSE_DB="$WORK_DIR/license.db"
AGENT_BIN="$ROOT/dist/relayx-agent"

export GOCACHE="${GOCACHE:-$ROOT/.gocache}"
export GOPATH="${GOPATH:-$ROOT/.gopath}"

mkdir -p "$WORK_DIR"
BACKEND_LOG="$WORK_DIR/backend.log"
LICENSE_LOG="$WORK_DIR/license.log"
AGENT_LOG="$WORK_DIR/agent.log"
ECHO_LOG="$WORK_DIR/echo.log"
WEB_LOG="$WORK_DIR/web.log"

say() { printf '\n[e2e] %s\n' "$*"; }
fail() {
  printf '\n[e2e] FAILED: %s\n' "$*" >&2
  if [[ -f "$BACKEND_LOG" ]]; then
    printf '\n--- backend.log (tail) ---\n' >&2
    tail -n 40 "$BACKEND_LOG" >&2 || true
  fi
  if [[ -f "$AGENT_LOG" ]]; then
    printf '\n--- agent.log (tail) ---\n' >&2
    tail -n 40 "$AGENT_LOG" >&2 || true
  fi
  if [[ -f "$LICENSE_LOG" ]]; then
    printf '\n--- license.log (tail) ---\n' >&2
    tail -n 20 "$LICENSE_LOG" >&2 || true
  fi
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

# Bound every setup step so a stalled Prisma/dotenv startup fails visibly instead
# of hanging the harness forever (observed on a loaded host).
run_step() {
  local label="$1" seconds="$2"
  shift 2
  timeout "$seconds" "$@" || fail "$label failed or timed out after ${seconds}s"
}

port_in_use() {
  # Prefer ss when present; fall back to a tiny TCP probe.
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1$"
    return
  fi
  node -e '
    const net = require("net");
    const s = net.connect(Number(process.argv[1]), "127.0.0.1");
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
    s.setTimeout(500, () => { s.destroy(); process.exit(1); });
  ' "$1"
}

require_free_port() {
  local port="$1"
  if port_in_use "$port"; then
    fail "port $port is already in use; stop the process or override the port env var"
  fi
}

wait_http() {
  local url="$1" label="$2" tries="${3:-120}"
  for ((i = 0; i < tries; i++)); do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  fail "$label did not become ready: $url"
}

wait_log() {
  local file="$1" pattern="$2" label="$3" tries="${4:-120}"
  for ((i = 0; i < tries; i++)); do
    if grep -qE "$pattern" "$file" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  fail "$label not observed in $file (pattern: $pattern)"
}

tcp_roundtrip() {
  local payload="$1"
  node -e '
    const net = require("net");
    const [port, expect] = process.argv.slice(1);
    const s = net.connect(Number(port), "127.0.0.1");
    let buf = "";
    const timer = setTimeout(() => {
      console.error("tcp roundtrip: timeout");
      process.exit(2);
    }, 5000);
    s.on("connect", () => s.write("e2e-probe"));
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes(expect)) {
        clearTimeout(timer);
        console.log(buf.trim());
        s.destroy();
        process.exit(0);
      }
    });
    s.on("error", (err) => {
      console.error(`tcp roundtrip: ${err.message}`);
      process.exit(3);
    });
  ' "$E2E_LISTEN_PORT" "$payload"
}

cleanup() {
  local code=$?
  set +e
  say "cleanup"
  for pid in "${WEB_PID:-}" "${AGENT_PID:-}" "${ECHO_PID:-}" "${BACKEND_PID:-}" "${LICENSE_PID:-}"; do
    [[ -n "$pid" ]] && kill -TERM -- "-$pid" 2>/dev/null
  done
  sleep 1
  for pid in "${WEB_PID:-}" "${AGENT_PID:-}" "${ECHO_PID:-}" "${BACKEND_PID:-}" "${LICENSE_PID:-}"; do
    [[ -n "$pid" ]] && kill -KILL -- "-$pid" 2>/dev/null
  done
  rm -f "$ROOT/relayx-agent.lock" "$ROOT/apps/agent/relayx-agent.lock"
  if [[ "${E2E_KEEP:-0}" != "1" ]]; then
    rm -rf "$WORK_DIR"
    rm -f "$ROOT/apps/backend/prisma/e2e.db" "$ROOT/apps/backend/prisma/e2e.db-journal"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
say "preflight"
for cmd in pnpm node curl; do require_cmd "$cmd"; done
require_free_port "$BACKEND_PORT"
require_free_port "$LICENSE_PORT"
require_free_port "$E2E_LISTEN_PORT"
require_free_port "$E2E_ECHO_PORT"
require_free_port "$WEB_PORT"
if [[ -f "$ROOT/.env" ]]; then
  CONFIG_SECRET="${CONFIG_SECRET:-$(grep -E '^CONFIG_SECRET=' "$ROOT/.env" | head -1 | cut -d= -f2-)}"
fi
CONFIG_SECRET="${CONFIG_SECRET:-KV/JjKrj8g6nNnvpQoViRs4QLLap5d9cRSwmMBOEdP4=}"

if [[ ! -x "$AGENT_BIN" || "${E2E_REBUILD:-0}" == "1" ]]; then
  say "building agent"
  run_step "agent build" 300 pnpm agent:build >/dev/null
fi

# ---------------------------------------------------------------------------
say "issue license for $SITE_URL"
pnpm --filter @relayx/license-server exec tsx src/index.ts \
  --db "$LICENSE_DB" --content-mode fernet \
  issue --site-url "$SITE_URL" --type business --days 1 >/dev/null \
  || fail "license issue failed"

say "start license server on :$LICENSE_PORT"
LICENSE_DB="$LICENSE_DB" LICENSE_PORT="$LICENSE_PORT" \
  setsid pnpm --filter @relayx/license-server start >"$LICENSE_LOG" 2>&1 &
LICENSE_PID=$!
disown "$LICENSE_PID" 2>/dev/null || true
wait_http "$LICENSE_URL/health" "license server" 120

# ---------------------------------------------------------------------------
say "reset database ($DATABASE_URL)"
run_step "database reset" 300 pnpm db:reset >/dev/null
run_step "seed" 240 pnpm seed

say "insert E2E fixtures"
FIXTURES="$(timeout 180 pnpm --filter @relayx/backend exec tsx scripts/e2e-fixtures.ts setup)" \
  || fail "fixtures setup failed"
printf '%s\n' "$FIXTURES"
TUNNEL_ID="$(node -e 'console.log(JSON.parse(process.argv[1]).tunnel_id)' "$FIXTURES")" \
  || fail "could not parse tunnel_id from fixtures"

say "start backend on :$BACKEND_PORT"
env DATABASE_URL="$DATABASE_URL" PORT="$BACKEND_PORT" SITE_URL="$SITE_URL" \
  LICENSE_URL="$LICENSE_URL" CONFIG_SECRET="$CONFIG_SECRET" \
  NODE_ENV=development TZ=Asia/Shanghai \
  setsid pnpm start >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
disown "$BACKEND_PID" 2>/dev/null || true
wait_http "$SITE_URL/health" "backend" 160 || fail "backend did not start"

say "start TCP echo target on :$E2E_ECHO_PORT"
setsid node -e '
  const net = require("net");
  const port = Number(process.argv[1]);
  net
    .createServer((socket) => {
      socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("pong:"), data])));
      socket.on("error", () => {});
    })
    .listen(port, "127.0.0.1", () => console.log(`echo listening on ${port}`));
' "$E2E_ECHO_PORT" >"$ECHO_LOG" 2>&1 &
ECHO_PID=$!
disown "$ECHO_PID" 2>/dev/null || true
wait_log "$ECHO_LOG" "echo listening" "echo server" 40 || fail "echo server did not start"

# ---------------------------------------------------------------------------
say "start agent"
setsid "$AGENT_BIN" \
  --server "$SITE_URL" \
  --token "$E2E_TOKEN" \
  --node-id e2e-node-1 \
  --connect-ip 127.0.0.1 \
  --config-secret "$CONFIG_SECRET" \
  -d >"$AGENT_LOG" 2>&1 &
AGENT_PID=$!
disown "$AGENT_PID" 2>/dev/null || true
wait_log "$AGENT_LOG" "license accepted" "agent license acceptance" 120 || fail "license not accepted"
wait_log "$AGENT_LOG" "config received \\(fernet\\): 2 service\\(s\\)" "config push with 2 services" 160 \
  || fail "agent did not receive the 2 services"
wait_log "$AGENT_LOG" "config applied: 2/2" "config apply" 160 || fail "agent did not apply the config"

# ---------------------------------------------------------------------------
say "assert TCP data plane"
REPLY="$(tcp_roundtrip "pong:e2e-probe")" || fail "tunnel did not echo through the agent"
printf '  tunnel reply: %s\n' "$REPLY"

# ---------------------------------------------------------------------------
say "assert agent observer loop (deployment /api prefix)"
wait_log "$BACKEND_LOG" '"url":"/tunnel/observer"' "agent observer POST" 160 \
  || fail "agent never posted to the observer endpoint"
if grep -q 'observer post .*401' "$AGENT_LOG"; then
  fail "agent observer POST was rejected with 401"
fi

say "assert OpenAPI document"
curl -fsS "$SITE_URL/openapi.json" -o "$WORK_DIR/openapi.json" || fail "GET /openapi.json failed"
node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const paths = Object.keys(doc.paths ?? {});
  const need = ["/bot", "/tunnel/{id}/test", "/admin/plan/coupon/{id}", "/user/info"];
  const missing = need.filter((p) => !paths.includes(p));
  if (missing.length) {
    console.error("missing paths: " + missing.join(", "));
    process.exit(1);
  }
  const bot = doc.paths["/bot"].get.responses["200"].content["application/json"].schema;
  if (bot?.type !== "object" || !bot.properties?.bind_key) {
    console.error("bot schema is not the raw JSON object");
    process.exit(1);
  }
  console.log(`  paths=${paths.length} bot=${JSON.stringify(Object.keys(bot.properties))}`);
' "$WORK_DIR/openapi.json" || fail "OpenAPI document is incomplete"

say "assert observer traffic accounting"
BEFORE="$(DATABASE_URL="$DATABASE_URL" E2E_TOKEN="$E2E_TOKEN" \
  pnpm --filter @relayx/backend exec tsx scripts/e2e-fixtures.ts traffic)"
printf '  before: %s\n' "$BEFORE"
# 2 MiB input + 2 MiB output = 4 MiB = 0.00390625 GiB
OBSERVER_BYTES=2097152
curl -fsS -X POST "$SITE_URL/api/tunnel/observer" \
  -H 'content-type: application/json' \
  -d "{\"events\":[{\"kind\":\"service\",\"service\":\"tcp-${TUNNEL_ID}\",\"type\":\"stats\",\"stats\":{\"totalConns\":1,\"currentConns\":0,\"inputBytes\":${OBSERVER_BYTES},\"outputBytes\":${OBSERVER_BYTES},\"totalErrs\":0}}]}" \
  >/dev/null || fail "observer POST failed"
AFTER="$(DATABASE_URL="$DATABASE_URL" E2E_TOKEN="$E2E_TOKEN" \
  pnpm --filter @relayx/backend exec tsx scripts/e2e-fixtures.ts traffic)"
printf '  after:  %s\n' "$AFTER"
node -e '
  const before = JSON.parse(process.argv[1]);
  const after = JSON.parse(process.argv[2]);
  const expected = (2 * 2 * 1024 * 1024) / 1024 ** 3;
  const gained = after.traffic - before.traffic;
  const gainedUsed = after.user_plan_traffic_used - before.user_plan_traffic_used;
  // The agent posts its own (tiny) observer deltas concurrently, so allow a
  // small margin below the exact 4 MiB / 1024^3 value.
  const ok = Math.abs(gained - expected) < 1e-4 && Math.abs(gainedUsed - expected) < 1e-4;
  console.log(`  gained traffic=${gained} user_plan=${gainedUsed} expected=${expected}`);
  if (!ok) {
    console.error("traffic accounting mismatch");
    process.exit(1);
  }
' "$BEFORE" "$AFTER" || fail "traffic accounting did not increment as expected"


say "build web console"
# Next inlines the rewrite target at build time, so the backend origin must be known here.
if [[ ! -f "$ROOT/apps/web/.next/BUILD_ID" || "${E2E_WEB_REBUILD:-0}" == "1" ]]; then
  BACKEND_ORIGIN="$SITE_URL" run_step "web build" 600 pnpm --filter @relayx/web build >/dev/null ||
    fail "web build failed"
else
  printf '  reusing %s\n' "$ROOT/apps/web/.next"
fi

say "start web console on :$WEB_PORT"
(
  cd "$ROOT/apps/web"
  BACKEND_ORIGIN="$SITE_URL" PORT="$WEB_PORT" NEXT_TELEMETRY_DISABLED=1 \
    exec ./node_modules/.bin/next start -H 127.0.0.1 -p "$WEB_PORT"
) >"$WEB_LOG" 2>&1 &
WEB_PID=$!
wait_http "$WEB_URL/" "web console" 160 || fail "web console did not start (see $WEB_LOG)"

say "assert web console: anonymous access is gated"
WEB_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/")"
[[ "$WEB_STATUS" == "200" ]] || fail "landing page returned $WEB_STATUS"
LOCATION="$(curl -s -o /dev/null -w '%{redirect_url}' "$WEB_URL/home")"
case "$LOCATION" in
  */handler/sign-in*) printf '  /home -> %s\n' "$LOCATION" ;;
  *) fail "anonymous /home did not redirect to sign-in (got '$LOCATION')" ;;
esac
printf '  / -> %s, /home -> 307 sign-in\n' "$WEB_STATUS"

say "assert web console: sign-up through the /api proxy"
WEB_EMAIL="web-${RANDOM}@example.test"
JAR="$WORK_DIR/web-cookies.txt"
SIGNUP_STATUS="$(curl -s -o "$WORK_DIR/web-signup.json" -w '%{http_code}' -c "$JAR" \
  -X POST "$WEB_URL/api/auth/sign-up" -H 'content-type: application/json' \
  -d "{\"email\":\"$WEB_EMAIL\",\"password\":\"e2e-supersecret\"}")"
[[ "$SIGNUP_STATUS" == "201" ]] || {
  cat "$WORK_DIR/web-signup.json" >&2
  fail "sign-up returned $SIGNUP_STATUS"
}
grep -q 'stack-access' "$JAR" || fail "sign-up did not set the stack-access cookie"
printf '  sign-up 201, cookie set\n'

say "assert web console: unverified session is pushed to /verify-email"
LOCATION="$(curl -s -b "$JAR" -o /dev/null -w '%{redirect_url}' "$WEB_URL/home")"
case "$LOCATION" in
  */verify-email*) printf '  /home -> %s\n' "$LOCATION" ;;
  *) fail "unverified /home did not redirect to /verify-email (got '$LOCATION')" ;;
esac

# No SMTP/Resend in the harness, so the endpoint returns the one-time link instead of
# mailing it; follow that link the way a user would.
VERIFY_LINK="$(curl -fsS -b "$JAR" -X POST "$WEB_URL/api/auth/verify-email/request" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const body = JSON.parse(raw);
    if (!body.link || !body.token) {
      console.error("verification link was not returned (no mail transport expected here)");
      process.exit(1);
    }
    console.log(body.link);
  });
')" || fail "verification link request failed"
VERIFY_TOKEN="${VERIFY_LINK#*token=}"
curl -fsS -b "$JAR" -X POST "$WEB_URL/api/auth/verify-email" \
  -H 'content-type: application/json' -d "{\"token\":\"$VERIFY_TOKEN\"}" >/dev/null ||
  fail "verify-email with the mailed token failed"
printf '  verification link token accepted\n' 

say "assert web console: verified session reaches the panel and the API"
HOME_STATUS="$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$WEB_URL/home")"
[[ "$HOME_STATUS" == "200" ]] || fail "/home returned $HOME_STATUS after verification"
VERIFY_LOCATION="$(curl -s -b "$JAR" -o /dev/null -w '%{redirect_url}' "$WEB_URL/verify-email")"
case "$VERIFY_LOCATION" in
  */home*) printf '  /verify-email -> %s\n' "$VERIFY_LOCATION" ;;
  *) fail "/verify-email did not redirect verified users home (got '$VERIFY_LOCATION')" ;;
esac
USER_EMAIL="$(curl -fsS -b "$JAR" "$WEB_URL/api/user/info" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const user = JSON.parse(raw);
    if (!user.email) { console.error("no email in /api/user/info"); process.exit(1); }
    console.log(user.email);
  });
')" || fail "/api/user/info did not return the signed-in user"
[[ "$USER_EMAIL" == "$WEB_EMAIL" ]] || fail "/api/user/info returned '$USER_EMAIL', expected '$WEB_EMAIL'"
ANON_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/api/user/info")"
[[ "$ANON_STATUS" == "401" ]] || fail "anonymous /api/user/info returned $ANON_STATUS, expected 401"
printf '  /home 200, /api/user/info -> %s, anonymous -> 401\n' "$USER_EMAIL"

say "PASS: license -> config -> TCP forward -> observer -> traffic accounting -> web console"

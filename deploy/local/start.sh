#!/usr/bin/env bash
#
# Local full-stack deployment — no Docker.
#
# Brings up the same two-process topology as production (SDD §14): an API process
# and a separate worker process, against Homebrew Postgres and Redis. The split
# matters even locally, because it is the thing that stops a PDF render from
# starving a request that is serving a signer mid-ceremony.
#
#   ./deploy/local/start.sh            # build, migrate, seed, start
#   ./deploy/local/start.sh --no-seed  # keep existing data
#   ./deploy/local/start.sh --reset    # drop databases AND local documents, then seed
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API="$ROOT/api"
WEB="$ROOT/web"
RUN="$ROOT/.run"
PORT="${PORT:-3100}"
WEB_PORT="${WEB_PORT:-3101}"
SEED=1
RESET=0
case "${1:-}" in
  --no-seed) SEED=0 ;;
  --reset)   RESET=1 ;;
esac

green() { printf '\033[32m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }
bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
fail()  { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

mkdir -p "$RUN"

bold $'\nGTIDS Agreement Portal — local deployment'

# ── Dependencies ─────────────────────────────────────────────────────────────
command -v psql >/dev/null || fail "postgresql not found. Run: brew install postgresql@16"
command -v redis-cli >/dev/null || fail "redis not found. Run: brew install redis"

pg_isready -q || {
  dim "starting postgresql…"
  brew services start postgresql@16 >/dev/null
  for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
}
pg_isready -q || fail "postgresql did not become ready"

redis-cli ping >/dev/null 2>&1 || {
  dim "starting redis…"
  brew services start redis >/dev/null
  for _ in $(seq 1 30); do redis-cli ping >/dev/null 2>&1 && break; sleep 1; done
}
redis-cli ping >/dev/null 2>&1 || fail "redis did not become ready"
green "postgresql and redis are up"

# ── Databases ────────────────────────────────────────────────────────────────
if [[ $RESET -eq 1 ]]; then
  # Database and document store are reset together, always.
  #
  # Agreement numbers restart at 000001 on a fresh database, and object keys are
  # derived from the number — so dropping one without the other makes the next
  # composition collide with a file left by the previous run, and the write-once
  # guard refuses it. Correctly, but confusingly.
  dim "resetting databases and local document storage…"
  "$ROOT/deploy/local/stop.sh" --quiet 2>/dev/null || true
  dropdb --if-exists gtids_agreements
  dropdb --if-exists gtids_agreements_test
  rm -rf "$API/storage" "$API/.test-storage"
fi

createdb gtids_agreements 2>/dev/null && dim "created database gtids_agreements" || true
createdb gtids_agreements_test 2>/dev/null && dim "created database gtids_agreements_test" || true

cd "$API"
[[ -f .env ]] || { cp .env.example .env; dim "wrote api/.env from the example"; }
[[ -d node_modules ]] || { dim "installing dependencies…"; npm ci --silent; }

# ── Build, migrate, seed ─────────────────────────────────────────────────────
dim "building…"
npm run build --silent >/dev/null
green "built"

npm run migrate --silent >/dev/null 2>&1 && green "migrations applied" || fail "migrations failed"

if [[ $SEED -eq 1 ]]; then
  # Not swallowed. The seed is idempotent, so a failure here means something is
  # genuinely wrong — and a half-applied seed once left the database with no
  # roles at all, which looks like a permissions bug three layers away.
  if ! seed_out="$(npm run seed --silent 2>&1)"; then
    printf '\033[31m%s\033[0m\n' "seed failed:" >&2
    echo "$seed_out" >&2
    exit 1
  fi
  green "seed data loaded"
fi

# ── Stop anything already running ────────────────────────────────────────────
"$ROOT/deploy/local/stop.sh" --quiet 2>/dev/null || true

# A process already holding the port is not necessarily ours. Node will happily
# bind IPv6 while another process holds IPv4, and then `localhost` reaches
# whichever the resolver picks — which looks like the API returning nonsense.
# Refuse rather than produce that.
for p in "$PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '\033[31m%s\033[0m\n' "port $p is already in use by:" >&2
    lsof -nP -iTCP:"$p" -sTCP:LISTEN | tail -n +2 | awk '{print "  " $1, "pid", $2}' >&2
    echo "Choose another: PORT=3200 WEB_PORT=3201 ./deploy/local/start.sh" >&2
    exit 1
  fi
done

# ── Start ────────────────────────────────────────────────────────────────────
# The worker owns the scheduled jobs; the API must not, or a render would compete
# with request handling for the same event loop.
RUN_SCHEDULER=true nohup node dist/worker.js > "$RUN/worker.log" 2>&1 &
echo $! > "$RUN/worker.pid"

PORT="$PORT" RUN_SCHEDULER=false nohup node dist/main.js > "$RUN/api.log" 2>&1 &
echo $! > "$RUN/api.pid"

# ── Wait for readiness ───────────────────────────────────────────────────────
dim "waiting for readiness…"
for _ in $(seq 1 40); do
  if curl -fs "http://localhost:$PORT/api/v1/health/ready" >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 0.5
done

if [[ "${READY:-0}" != "1" ]]; then
  printf '\033[31m%s\033[0m\n' "api did not become ready — last 20 lines:"
  tail -20 "$RUN/api.log"
  exit 1
fi

green "api ready on http://localhost:$PORT"
green "worker running (notifications, reconciliation, SLA sweep, integrity checks)"

# ── Web UI ───────────────────────────────────────────────────────────────────
if [[ -d "$WEB" ]]; then
  cd "$WEB"
  [[ -d node_modules ]] || { dim "installing web dependencies…"; npm ci --silent; }
  dim "building web…"
  npm run build --silent >/dev/null 2>&1 || fail "web build failed"

  # API_ORIGIN is read by both the server-side client and the /api proxy rewrite,
  # so the browser stays same-origin and the API needs no CORS opening.
  API_ORIGIN="http://localhost:$PORT" nohup npx next start -p "$WEB_PORT" \
    > "$RUN/web.log" 2>&1 &
  echo $! > "$RUN/web.pid"

  for _ in $(seq 1 40); do
    curl -fs "http://localhost:$WEB_PORT/login" >/dev/null 2>&1 && { WEB_READY=1; break; }
    sleep 0.5
  done
  if [[ "${WEB_READY:-0}" == "1" ]]; then
    green "web ready on http://localhost:$WEB_PORT"
  else
    printf '\033[31m%s\033[0m\n' "web did not become ready — last 20 lines:"
    tail -20 "$RUN/web.log"
  fi
fi

echo
curl -s "http://localhost:$PORT/api/v1/health/ready" | node -e \
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);
   console.log('  database      :', j.checks.database.ok ? 'ok' : 'DOWN');
   console.log('  esign provider:', j.checks.esignProvider.detail);});"

cat <<EOF

$(bold 'Next')
  open http://localhost:$WEB_PORT   the portal
  npm --prefix api run demo        run the full Agent → Employee → MD walkthrough
  tail -f .run/api.log             API logs
  tail -f .run/worker.log          worker logs
  ./deploy/local/stop.sh           stop both processes

$(dim 'Seeded users — password: ChangeMe-Dev-2026!')
$(dim '  admin@gtids.example  ops@gtids.example  agent@gtids.example')
$(dim '  employee@gtids.example  md@gtids.example  auditor@gtids.example')

$(printf '\033[33m%s\033[0m' 'This is a development deployment.') $(dim 'The eSign provider is a mock and')
$(dim 'assertProductionConfig will refuse to boot with NODE_ENV=production until DEC-002 closes.')
EOF

#!/usr/bin/env bash
#
# Deploy a release onto the GTIDS server.
#
#   sudo ./deploy.sh /path/to/checkout          # deploy that working tree
#   sudo ./deploy.sh --rollback                 # return to the previous release
#
# Releases are built into a timestamped directory and switched by moving the
# `current` symlink, so a failed build never touches the running service and a
# rollback is one symlink move.
#
set -euo pipefail

APP_USER="${APP_USER:-gtids}"
APP_HOME="${APP_HOME:-/opt/gtids-agreements}"
RELEASES="$APP_HOME/releases"
CURRENT="$APP_HOME/current"
KEEP="${KEEP:-5}"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

log()  { printf '\033[32m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31m!!!\033[0m %s\n' "$1" >&2; exit 1; }

services=(gtids-api gtids-worker gtids-web)

restart_all() {
  systemctl daemon-reload
  # Worker first: it is idempotent and holds no client connections. The API last,
  # so the moment it starts serving, everything it depends on is already up.
  systemctl restart gtids-worker
  systemctl restart gtids-web
  systemctl restart gtids-api
}

wait_healthy() {
  log "Waiting for readiness"
  for _ in $(seq 1 60); do
    body="$(curl -fs http://127.0.0.1:3100/api/v1/health/ready || true)"
    if [[ "$body" == *'"status":"ready"'* ]]; then
      log "API reports ready"
      echo "$body"
      return 0
    fi
    sleep 1
  done
  echo "--- last 40 lines of api.log ---" >&2
  tail -40 /var/log/gtids/api.log >&2 || true
  return 1
}

# ── Rollback ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--rollback" ]]; then
  previous="$(ls -1dt "$RELEASES"/* | sed -n 2p)"
  [[ -n "$previous" ]] || fail "No previous release to roll back to."
  log "Rolling back to $(basename "$previous")"
  ln -sfn "$previous" "$CURRENT"
  restart_all
  wait_healthy || fail "Rollback did not become healthy."
  log "Rolled back."
  echo
  echo "NOTE: database migrations are not rolled back. If the release you are"
  echo "leaving added a migration, confirm the previous code tolerates the new"
  echo "schema before considering this complete."
  exit 0
fi

SOURCE="${1:-}"
[[ -d "$SOURCE" ]] || fail "Usage: $0 /path/to/checkout   (or --rollback)"
[[ -f /etc/gtids/api.env ]] || fail "/etc/gtids/api.env is missing. Run provision.sh first."

# ── Pre-flight ───────────────────────────────────────────────────────────────
STORAGE_ROOT="$(grep -E '^STORAGE_FS_ROOT=' /etc/gtids/api.env | cut -d= -f2- | tr -d '"')"
DEPLOY_ENV="$(grep -E '^NODE_ENV=' /etc/gtids/api.env | cut -d= -f2- | tr -d '"')"

if [[ "$DEPLOY_ENV" == "production" ]]; then
  if [[ ! -f "$STORAGE_ROOT/.gtids-storage-root" ]]; then
    fail "The NAS marker $STORAGE_ROOT/.gtids-storage-root is missing.
The export is probably not mounted. Deploying now would produce a service that
refuses to start — fix the mount first."
  fi
else
  # Staging legitimately runs on local disk before the NAS window. The marker is
  # a production requirement, so its absence here is expected — but say so, and
  # refuse the one arrangement that destroys documents later.
  printf '\033[33m!!!\033[0m %s\n' "NODE_ENV=$DEPLOY_ENV — deploying as staging, not production."
  printf '\033[33m!!!\033[0m %s\n' "Documents go to $STORAGE_ROOT and are outside the NAS backup policy."
  if [[ "$STORAGE_ROOT" == "/srv/gtids/agreements" ]] && ! mountpoint -q "$STORAGE_ROOT"; then
    fail "Staging storage is the future NAS mountpoint and nothing is mounted there.
Mounting the export later would hide every document written until then.
Point STORAGE_FS_ROOT somewhere else, e.g. /var/lib/gtids/agreements-staging."
  fi
fi

[[ -d "$STORAGE_ROOT" ]] || fail "Storage root $STORAGE_ROOT does not exist."

RELEASE="$RELEASES/$(date -u +%Y%m%d-%H%M%S)"
log "Building release $(basename "$RELEASE")"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$RELEASE"

# Copy the source without the working-tree clutter.
#
# Every exclusion is an explicit anchored path. Unanchored patterns match a
# component at ANY depth: '--exclude=storage' also removed api/src/documents/
# storage/, the NAS storage driver, and the release failed to build with six
# unresolved imports. Same trap as an unanchored .gitignore rule.
tar -C "$SOURCE" --anchored \
    --exclude='./.git' \
    --exclude='./.run' \
    --exclude='./api/node_modules' --exclude='./api/dist' --exclude='./api/coverage' \
    --exclude='./api/storage' --exclude='./api/.test-storage' --exclude='./api/demo-output' \
    --exclude='./web/node_modules' --exclude='./web/.next' \
    --exclude='./web/test-results' --exclude='./web/playwright-report' \
    --exclude='./spike/pdf-signing/node_modules' --exclude='./spike/pdf-signing/out' \
    -cf - . | tar -C "$RELEASE" -xf -
chown -R "$APP_USER":"$APP_USER" "$RELEASE"

# Prove the copy is complete before spending minutes building it. A missing
# source file otherwise surfaces as a confusing compile error several steps later.
src_count="$(find "$SOURCE/api/src" -name '*.ts' | wc -l)"
rel_count="$(find "$RELEASE/api/src" -name '*.ts' 2>/dev/null | wc -l)"
if [[ "$src_count" -ne "$rel_count" ]]; then
  fail "Release copy is incomplete: $rel_count of $src_count TypeScript files under api/src.
An exclusion pattern is matching source files. Compare:
  find $SOURCE/api/src -name '*.ts' | sort > /tmp/src.txt
  find $RELEASE/api/src -name '*.ts' | sed 's|$RELEASE|$SOURCE|' | sort > /tmp/rel.txt
  diff /tmp/src.txt /tmp/rel.txt"
fi
log "Release copy verified ($rel_count source files)"

log "Installing API dependencies"
sudo -u "$APP_USER" bash -c "cd '$RELEASE/api' && npm ci --omit=dev --silent" \
  || fail "API dependency install failed."

log "Building API"
# The build needs the dev dependencies (TypeScript), so install them, build, then
# prune back to a production tree.
sudo -u "$APP_USER" bash -c "cd '$RELEASE/api' && npm ci --silent && npm run build --silent && npm prune --omit=dev" \
  || fail "API build failed."

log "Installing Chromium for the PDF renderer"
# Not the default ~/.cache/ms-playwright: the services run with ProtectHome=true,
# so anything under /home is invisible to them and the renderer would fail at the
# first agreement with a confusing "browser not found".
BROWSERS="$APP_HOME/browsers"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$BROWSERS"
sudo -u "$APP_USER" bash -c "cd '$RELEASE/api' && PLAYWRIGHT_BROWSERS_PATH='$BROWSERS' npx playwright install chromium" \
  || fail "Chromium install failed — PDF_RENDERER=playwright would fail at runtime."

log "Building web UI"
sudo -u "$APP_USER" bash -c "cd '$RELEASE/web' && npm ci --silent && npm run build --silent" \
  || fail "Web build failed."

# ── Migrate ──────────────────────────────────────────────────────────────────
# Run before the switch: the new code expects the new schema. Migrations here are
# additive, so the old release keeps working if the switch is aborted.
log "Applying database migrations"
sudo -u "$APP_USER" bash -c "cd '$RELEASE/api' && set -a && . /etc/gtids/api.env && set +a && npm run migrate" \
  || fail "Migrations failed — the running release is untouched."

# ── Switch ───────────────────────────────────────────────────────────────────
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
log "Switching current -> $(basename "$RELEASE")"
ln -sfn "$RELEASE" "$CURRENT"

restart_all

if ! wait_healthy; then
  if [[ -n "$PREVIOUS" ]]; then
    log "Unhealthy after deploy — rolling back automatically"
    ln -sfn "$PREVIOUS" "$CURRENT"
    restart_all
    wait_healthy || fail "Rollback also unhealthy. Manual intervention required."
    fail "Deploy failed and was rolled back to $(basename "$PREVIOUS")."
  fi
  fail "Deploy failed and there is no previous release to fall back to."
fi

# ── Tidy ─────────────────────────────────────────────────────────────────────
log "Pruning old releases (keeping $KEEP)"
ls -1dt "$RELEASES"/* | tail -n +$((KEEP + 1)) | xargs -r rm -rf

log "Deployed $(basename "$RELEASE")"
for s in "${services[@]}"; do
  printf '  %-14s %s\n' "$s" "$(systemctl is-active "$s")"
done

echo
grep -q '^ESIGN_PROVIDER=mock' /etc/gtids/api.env && cat <<'EOF'
NOTE: ESIGN_PROVIDER is still "mock". The API refuses to start in production with
that setting, so this deployment is only usable with NODE_ENV != production.
Close DEC-002 before go-live.
EOF

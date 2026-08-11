#!/usr/bin/env bash
#
# Check a server is ready to run the Agreement Portal — before deploying, and
# again whenever something looks wrong.
#
#   sudo ./preflight.sh              # production readiness — the real gate
#   sudo ./preflight.sh --staging    # before the NAS exists; NAS and provider
#                                    # checks become warnings, not failures
#
# Read-only: changes nothing. Exit code 0 means every hard requirement is met.
#
set -uo pipefail

STORAGE_ROOT="${STORAGE_ROOT:-}"
ENV_FILE="${ENV_FILE:-/etc/gtids/api.env}"
APP_USER="${APP_USER:-gtids}"
STAGING=0
[[ "${1:-}" == "--staging" ]] && STAGING=1

pass=0; warn=0; failn=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31m✗\033[0m %s\n' "$1"; failn=$((failn+1)); }
hmm()  { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# In staging, the things that are legitimately absent until the NAS is mounted and
# the ESP is contracted are reported but do not block. Everything else is still a
# hard failure — staging is a phase of the same install, not a lower standard.
gate() { if [[ $STAGING -eq 1 ]]; then hmm "$1 (deferred: staging)"; else no "$1"; fi; }

printf '\n\033[1mGTIDS Agreement Portal — server preflight\033[0m\n'
[[ $STAGING -eq 1 ]] && printf '\033[33m%s\033[0m\n' \
  'STAGING MODE — not a go-live check. NAS and eSign provider checks are advisory.'

head_ "Operating system"
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  ok "$PRETTY_NAME"
  [[ "$ID" =~ ^(ubuntu|debian)$ ]] || hmm "Scripts target Ubuntu/Debian; adapt package steps for $ID"
else
  hmm "Cannot identify the distribution"
fi
[[ "$(uname -m)" == "x86_64" || "$(uname -m)" == "aarch64" ]] \
  && ok "architecture $(uname -m)" || hmm "unusual architecture $(uname -m)"

head_ "Required software"
for cmd in node npm psql redis-cli nginx curl openssl; do
  if command -v "$cmd" >/dev/null; then ok "$cmd — $(command -v "$cmd")"; else no "$cmd is not installed"; fi
done
if command -v node >/dev/null; then
  major="$(node -v | cut -c2- | cut -d. -f1)"
  [[ "$major" -ge 20 ]] && ok "Node.js $(node -v)" || no "Node.js $(node -v) is too old (need 20+)"
fi
command -v pdfsig >/dev/null && ok "pdfsig (poppler) available for signature checks" \
  || hmm "poppler-utils not installed — signature spot-checks unavailable"

head_ "Services"
systemctl is-active --quiet postgresql && ok "postgresql running" || no "postgresql is not running"
systemctl is-active --quiet redis-server && ok "redis running" || no "redis is not running"
if redis-cli ping >/dev/null 2>&1; then
  ok "redis responds"
  # BullMQ durability: without AOF a restart loses queued completion emails.
  [[ "$(redis-cli config get appendonly 2>/dev/null | tail -1)" == "yes" ]] \
    && ok "redis AOF persistence enabled" \
    || no "redis appendonly is off — queued notifications would not survive a restart"
else
  no "redis does not respond"
fi

head_ "PostgreSQL configuration"
if command -v psql >/dev/null && systemctl is-active --quiet postgresql; then
  ver="$(sudo -u postgres psql -tAc 'SHOW server_version' 2>/dev/null | cut -d. -f1)"
  [[ -n "$ver" && "$ver" -ge 14 ]] && ok "PostgreSQL $ver" || hmm "PostgreSQL version $ver (14+ expected)"
  [[ "$(sudo -u postgres psql -tAc 'SHOW archive_mode' 2>/dev/null)" == "on" ]] \
    && ok "WAL archiving on (point-in-time recovery available)" \
    || no "archive_mode is off — the 15-minute RPO target cannot be met"
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='gtids_app'" 2>/dev/null | grep -q 1 \
    && ok "role gtids_app exists" || hmm "role gtids_app not found (created by provision.sh)"
fi

head_ "Service account and paths"
id -u "$APP_USER" >/dev/null 2>&1 && ok "user $APP_USER exists" || no "user $APP_USER does not exist"
[[ -d /var/log/gtids ]] && ok "/var/log/gtids exists" || hmm "/var/log/gtids missing"
if [[ -f "$ENV_FILE" ]]; then
  ok "$ENV_FILE present"
  perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  [[ "$perms" == "640" || "$perms" == "600" ]] \
    && ok "environment file mode $perms" \
    || no "environment file is mode $perms — it holds database and signing secrets"
  # The environment file is what the service actually reads, so it wins over an
  # ambient shell variable. Preferring the export made this report on a path the
  # service was not using — which is exactly how a check gives false confidence.
  env_root="$(grep -E '^STORAGE_FS_ROOT=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
  if [[ -n "$env_root" ]]; then
    if [[ -n "$STORAGE_ROOT" && "$STORAGE_ROOT" != "$env_root" ]]; then
      hmm "STORAGE_ROOT is exported as '$STORAGE_ROOT' but $ENV_FILE says '$env_root' — checking the latter"
    fi
    STORAGE_ROOT="$env_root"
  fi
else
  no "$ENV_FILE not found — run provision.sh"
fi
STORAGE_ROOT="${STORAGE_ROOT:-/srv/gtids/agreements}"

head_ "Document storage (NAS)"
printf '  \033[2mpath: %s\033[0m\n' "$STORAGE_ROOT"
if [[ -d "$STORAGE_ROOT" ]]; then
  ok "storage directory exists"
  if mountpoint -q "$STORAGE_ROOT"; then
    ok "it is a mountpoint"
    printf '  \033[2m%s\033[0m\n' "$(findmnt -no SOURCE,FSTYPE,OPTIONS "$STORAGE_ROOT" 2>/dev/null)"
    opts="$(findmnt -no OPTIONS "$STORAGE_ROOT" 2>/dev/null)"
    # `soft` returns an I/O error on a network blip; a signed agreement can be lost.
    [[ "$opts" == *soft* ]] && no "mounted 'soft' — use 'hard' so a network blip blocks instead of failing"
    [[ "$opts" == *hard* ]] && ok "mounted 'hard'"
  else
    gate "NOT a mountpoint — agreements would be written to the local disk"
  fi

  # The guard against a silently unmounted share — and against a fake guard.
  if [[ -f "$STORAGE_ROOT/.gtids-storage-root" ]]; then
    if mountpoint -q "$STORAGE_ROOT"; then
      ok "NAS marker file present"
    else
      # Worse than a missing marker: it satisfies the check while the share is
      # absent, so the API starts and writes agreements to local disk. Mounting
      # the export later hides them permanently.
      no "marker exists but $STORAGE_ROOT is NOT mounted — this is a FALSE marker.
    It defeats the very guard it represents. Remove it:
      rm -f $STORAGE_ROOT/.gtids-storage-root
    Create it only after the export is mounted."
    fi
  else
    gate "marker .gtids-storage-root missing — the API will refuse to start in production"
  fi

  sudo -u "$APP_USER" test -w "$STORAGE_ROOT" 2>/dev/null \
    && ok "$APP_USER can write to it" || no "$APP_USER cannot write to $STORAGE_ROOT"

  free_kb="$(df -Pk "$STORAGE_ROOT" | awk 'NR==2{print $4}')"
  free_gb=$((free_kb / 1024 / 1024))
  [[ "$free_gb" -ge 5 ]] && ok "${free_gb} GB free" || no "only ${free_gb} GB free"

  # Prove durability rather than assume it: hard links are how write-once and
  # atomic publication are implemented.
  probe="$STORAGE_ROOT/.preflight-$$"
  if sudo -u "$APP_USER" touch "$probe" 2>/dev/null; then
    if sudo -u "$APP_USER" ln "$probe" "$probe.link" 2>/dev/null; then
      ok "hard links work on this share (required for atomic write-once)"
      sudo -u "$APP_USER" rm -f "$probe.link"
    else
      no "hard links are NOT supported here — the storage driver cannot guarantee write-once"
    fi
    sudo -u "$APP_USER" rm -f "$probe"
  else
    no "cannot create a file as $APP_USER"
  fi
else
  no "storage directory $STORAGE_ROOT does not exist"
fi

if [[ $STAGING -eq 1 && "$STORAGE_ROOT" == "/srv/gtids/agreements" ]] && ! mountpoint -q "$STORAGE_ROOT"; then
  no "Interim storage is on the future NAS mountpoint ($STORAGE_ROOT).
    Mounting the NAS there later would shadow every document written until then,
    leaving the database holding hashes for files nobody can read.
    Use a different path while the NAS is pending, e.g.
      STORAGE_FS_ROOT=/var/lib/gtids/agreements-staging"
fi

head_ "Network"
ss -ltn 2>/dev/null | grep -q ':443 ' && ok "something is listening on 443" || hmm "nothing on 443 yet"
for p in 3100 3101; do
  ss -ltn 2>/dev/null | grep -q ":$p " && hmm "port $p already in use" || ok "port $p free"
done
if command -v ufw >/dev/null; then
  ufw status 2>/dev/null | grep -q "Status: active" && ok "firewall active" || hmm "ufw is inactive"
fi
# Deploys build on the server, which needs the npm registry.
curl -fsS --max-time 8 https://registry.npmjs.org/ >/dev/null 2>&1 \
  && ok "npm registry reachable (needed by deploy.sh)" \
  || no "cannot reach the npm registry — deploy.sh cannot install dependencies"

head_ "Configuration sanity"
if [[ -f "$ENV_FILE" ]]; then
  get() { grep -E "^$1=" "$ENV_FILE" | cut -d= -f2- | tr -d '"'; }
  if [[ "$(get NODE_ENV)" == "production" ]]; then
    ok "NODE_ENV=production"
  elif [[ $STAGING -eq 1 ]]; then
    hmm "NODE_ENV=$(get NODE_ENV) — correct for staging; the production guards are inactive"
  else
    no "NODE_ENV is '$(get NODE_ENV)', not production"
  fi
  [[ "$(get PDF_RENDERER)" == "playwright" ]] && ok "PDF_RENDERER=playwright" \
    || gate "PDF_RENDERER must be 'playwright' in production"
  [[ "$(get ESIGN_PROVIDER)" == "mock" ]] \
    && gate "ESIGN_PROVIDER=mock — production will refuse to start (DEC-002 still open)" \
    || ok "ESIGN_PROVIDER=$(get ESIGN_PROVIDER)"
  [[ "$(get SMTP_TRANSPORT)" == "smtp" ]] && ok "SMTP_TRANSPORT=smtp" \
    || gate "SMTP_TRANSPORT is '$(get SMTP_TRANSPORT)' — no mail would be sent"
  [[ -n "$(get SMTP_HOST)" ]] && ok "SMTP host configured" || gate "SMTP_HOST is empty"
  case "$(get JWT_SECRET)" in
    *change-me*|*dev-only*|"") no "JWT_SECRET is a placeholder" ;;
    *) ok "JWT_SECRET set" ;;
  esac
  case "$(get ESIGN_CALLBACK_SECRET)" in
    *change-me*|*dev-only*|"") no "ESIGN_CALLBACK_SECRET is a placeholder" ;;
    *) ok "ESIGN_CALLBACK_SECRET set" ;;
  esac
  [[ "$(get DATABASE_URL)" == *"gtids_app"* ]] \
    && ok "application connects as gtids_app (least privilege on audit_logs)" \
    || no "DATABASE_URL does not use gtids_app — the audit privilege layer is lost"
  [[ "$(get PUBLIC_VERIFY_BASE_URL)" == *"/verify"* && "$(get PUBLIC_VERIFY_BASE_URL)" != *"/api/"* ]] \
    && ok "verification URL points at the web UI" \
    || no "PUBLIC_VERIFY_BASE_URL should be https://<host>/verify — a QR must not resolve to JSON"
fi

printf '\n\033[1mResult:\033[0m %d passed, %d warning(s), %d blocking\n' "$pass" "$warn" "$failn"
if [[ "$failn" -gt 0 ]]; then
  printf '\033[31mNot ready.\033[0m Resolve the ✗ items above.\n\n'
  exit 1
fi
if [[ $STAGING -eq 1 ]]; then
  printf '\033[33mReady to deploy as STAGING.\033[0m\n'
  printf 'Before go-live, re-run without --staging and clear every ✗ and !.\n'
  printf 'Do not execute agreements you need to keep until the NAS is mounted.\n\n'
else
  printf '\033[32mReady to deploy.\033[0m\n\n'
fi

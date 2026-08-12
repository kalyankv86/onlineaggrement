#!/usr/bin/env bash
#
# Provision a GTIDS-owned server to run the Agreement Portal.
#
# Target: Ubuntu 22.04/24.04 LTS or Debian 12, on GTIDS hardware. No Docker, no
# cloud services. Documents live on a NAS export mounted at $STORAGE_ROOT.
#
#   sudo ./provision.sh
#
# Idempotent — safe to re-run after a change.
#
set -euo pipefail

APP_USER="${APP_USER:-gtids}"
APP_HOME="${APP_HOME:-/opt/gtids-agreements}"
STORAGE_ROOT="${STORAGE_ROOT:-/srv/gtids/agreements}"
NAS_EXPORT="${NAS_EXPORT:-}"                 # e.g. nas.gtids.internal:/volume1/agreements
SITE="${SITE:-agreements.gtids.example}"     # the public hostname
DB_NAME="${DB_NAME:-gtids_agreements}"
DB_OWNER="${DB_OWNER:-gtids_owner}"
DB_APP="${DB_APP:-gtids_app}"
NODE_MAJOR="${NODE_MAJOR:-22}"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

log()  { printf '\033[32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!!!\033[0m %s\n' "$1"; }

# ── Packages ─────────────────────────────────────────────────────────────────
log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg git ufw nginx \
  postgresql postgresql-contrib redis-server \
  nfs-common cifs-utils \
  poppler-utils \
  fonts-liberation fonts-dejavu-core \
  tesseract-ocr tesseract-ocr-eng \
  libreoffice-writer libreoffice-core

# tesseract-ocr reads the stamp paper scans (DEC-026); pdftoppm from
# poppler-utils rasterises PDF scans for it. libreoffice-writer converts uploaded
# Word agreements to PDF (DEC-025) — writer alone, not the whole suite, to keep
# the install small. Both run offline, which suits a server with no egress.

# Chromium's own runtime libraries. Playwright renders the agreement PDFs, and
# these are what it silently fails without.
apt-get install -y -qq \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
  libcairo2 libasound2t64 2>/dev/null || \
apt-get install -y -qq \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
  libcairo2 libasound2

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi

# ── Service account ──────────────────────────────────────────────────────────
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Creating service user $APP_USER"
  # No login shell: this account exists to run the service, not to be used.
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_HOME"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_HOME/releases"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 /var/log/gtids
install -d -o root -g "$APP_USER" -m 0750 /etc/gtids

# ── NAS mount ────────────────────────────────────────────────────────────────
log "Preparing document storage at $STORAGE_ROOT"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$STORAGE_ROOT"

if [[ -n "$NAS_EXPORT" ]]; then
  if ! grep -q "[[:space:]]${STORAGE_ROOT}[[:space:]]" /etc/fstab; then
    log "Adding NAS export to /etc/fstab"
    # hard,intr: block rather than return an I/O error if the NAS is briefly
    # unreachable. A signed agreement must never be lost to a transient blip.
    # noatime: agreements are written once and read rarely; atime is pure cost.
    cat >> /etc/fstab <<EOF

# GTIDS agreement document store
${NAS_EXPORT}  ${STORAGE_ROOT}  nfs  rw,hard,intr,noatime,vers=4.1,_netdev  0  0
EOF
  fi
  mountpoint -q "$STORAGE_ROOT" || mount "$STORAGE_ROOT"
fi

if mountpoint -q "$STORAGE_ROOT"; then
  log "NAS is mounted at $STORAGE_ROOT"
  # The marker lives ON the NAS. Its absence is how the application detects an
  # unmounted share and refuses to write agreements to the local disk.
  sudo -u "$APP_USER" touch "$STORAGE_ROOT/.gtids-storage-root"
  chmod 0640 "$STORAGE_ROOT/.gtids-storage-root"
else
  warn "$STORAGE_ROOT is NOT a mountpoint."
  warn "Mount the NAS export there, then run:"
  warn "  sudo -u $APP_USER touch $STORAGE_ROOT/.gtids-storage-root"
  warn "The API will refuse to start until that marker exists."
fi

# ── PostgreSQL ───────────────────────────────────────────────────────────────
log "Configuring PostgreSQL"
OWNER_PW="$(openssl rand -base64 30 | tr -d '/+=' | head -c 32)"
APP_PW="$(openssl rand -base64 30 | tr -d '/+=' | head -c 32)"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_OWNER}') THEN
    CREATE ROLE ${DB_OWNER} LOGIN PASSWORD '${OWNER_PW}';
  END IF;
  -- gtids_app is created by migration 009 as NOLOGIN; give it a password so the
  -- application can connect as the least-privileged role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_APP}') THEN
    CREATE ROLE ${DB_APP} LOGIN PASSWORD '${APP_PW}';
  ELSE
    ALTER ROLE ${DB_APP} LOGIN PASSWORD '${APP_PW}';
  END IF;
END \$\$;
SQL

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres createdb -O "$DB_OWNER" "$DB_NAME"

# Point-in-time recovery. RPO <= 15 min (SRS v1.1 §11) depends on this.
PG_CONF="$(sudo -u postgres psql -tAc 'SHOW config_file')"
if ! grep -q '^# GTIDS' "$PG_CONF"; then
  log "Enabling WAL archiving for point-in-time recovery"
  install -d -o postgres -g postgres -m 0750 /var/lib/postgresql/wal_archive
  cat >> "$PG_CONF" <<'EOF'

# GTIDS agreement portal
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/lib/postgresql/wal_archive/%f && cp %p /var/lib/postgresql/wal_archive/%f'
archive_timeout = 900        # forces a WAL segment every 15 minutes: the RPO target
EOF
  systemctl restart postgresql
fi

# ── Redis ────────────────────────────────────────────────────────────────────
log "Configuring Redis"
# BullMQ job durability depends on AOF. Without it, a restart loses queued
# completion emails — and BR-008 says a completed agreement must be notified.
sed -i 's/^appendonly .*/appendonly yes/' /etc/redis/redis.conf
grep -q '^appendonly yes' /etc/redis/redis.conf || echo 'appendonly yes' >> /etc/redis/redis.conf
sed -i 's/^# *bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server

# ── Firewall ─────────────────────────────────────────────────────────────────
log "Configuring firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
# Postgres, Redis and the Node processes are reachable only from the host itself;
# nginx is the single ingress.
ufw --force enable >/dev/null

# ── Environment file ─────────────────────────────────────────────────────────
if [[ ! -f /etc/gtids/api.env ]]; then
  log "Writing /etc/gtids/api.env"
  cat > /etc/gtids/api.env <<EOF
NODE_ENV=production
PORT=3100
API_BASE_URL=https://${SITE}
# Must point at the WEB UI's /verify page: this URL is what the QR on a completed
# agreement encodes, and a counterparty scanning it should get a readable answer.
PUBLIC_VERIFY_BASE_URL=https://${SITE}/verify

DATABASE_URL=postgresql://${DB_APP}:${APP_PW}@127.0.0.1:5432/${DB_NAME}
MIGRATION_DATABASE_URL=postgresql://${DB_OWNER}:${OWNER_PW}@127.0.0.1:5432/${DB_NAME}

REDIS_URL=redis://127.0.0.1:6379

STORAGE_FS_ROOT=${STORAGE_ROOT}
STORAGE_SIGNED_URL_TTL_SECONDS=300

JWT_SECRET=$(openssl rand -hex 32)
JWT_ACCESS_TTL=30m
JWT_ABSOLUTE_TTL=12h
PARTY_ACCESS_TOKEN_TTL_HOURS=72
BCRYPT_ROUNDS=12

# DEC-002 — replace once the ESP/ASP is contracted. The service refuses to start
# in production while this says "mock".
ESIGN_PROVIDER=mock
ESIGN_CALLBACK_SECRET=$(openssl rand -hex 32)
ESIGN_CALLBACK_TOLERANCE_SECONDS=300
ESIGN_TRANSACTION_TTL_MINUTES=30

PDF_RENDERER=playwright
PDF_SIGNATURE_RESERVED_BYTES=8192

SMTP_TRANSPORT=smtp
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM="GTIDS Agreements <agreements@${SITE}>"

DEFAULT_STAGE_SLA_DAYS=14
DEFAULT_REMINDER_DAYS=3,7,12
MAX_SIGNATURE_ATTEMPTS=3
VERIFY_RATE_LIMIT_PER_MINUTE=10
EOF
  chown root:"$APP_USER" /etc/gtids/api.env
  chmod 0640 /etc/gtids/api.env
else
  warn "/etc/gtids/api.env exists — left untouched. Database passwords were rotated;"
  warn "update DATABASE_URL and MIGRATION_DATABASE_URL by hand if you re-ran this."
fi

if [[ ! -f /etc/gtids/web.env ]]; then
  cat > /etc/gtids/web.env <<EOF
NODE_ENV=production
PORT=3101
API_ORIGIN=http://127.0.0.1:3100
EOF
  chown root:"$APP_USER" /etc/gtids/web.env
  chmod 0640 /etc/gtids/web.env
fi

log "Provisioning complete."
cat <<EOF

Next:
  1. Edit /etc/gtids/api.env — hostname, SMTP credentials, and the eSign provider.
  2. Confirm the NAS is mounted and the marker exists:
       mountpoint $STORAGE_ROOT && ls -la $STORAGE_ROOT/.gtids-storage-root
  3. Install the systemd units and nginx site:
       ./deploy/server/install-units.sh
  4. Deploy a release:
       ./deploy/server/deploy.sh /path/to/checkout

Postgres roles created. The application connects as ${DB_APP}, which holds no
UPDATE or DELETE on audit_logs — that is the first of the three layers protecting
the audit trail, and it only works if the app uses this role rather than the owner.
EOF

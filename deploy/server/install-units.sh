#!/usr/bin/env bash
#
# Install the systemd units, nginx site and scheduled backup.
#
#   sudo ./install-units.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="${SITE:-agreements.gtids.example}"
APP_USER="${APP_USER:-gtids}"
APP_HOME="${APP_HOME:-/opt/gtids-agreements}"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
log() { printf '\033[32m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31m!!!\033[0m %s\n' "$1" >&2; exit 1; }

# The storage path is taken from the environment file rather than guessed. The
# units must name the real mountpoint: RequiresMountsFor and ReadWritePaths both
# depend on it, and a stale default would produce a service that either starts
# before the NAS is mounted or cannot write to it at all.
if [[ -f /etc/gtids/api.env ]]; then
  STORAGE_ROOT="$(grep -E '^STORAGE_FS_ROOT=' /etc/gtids/api.env | cut -d= -f2- | tr -d '"')"
fi
STORAGE_ROOT="${STORAGE_ROOT:-/srv/gtids/agreements}"
[[ "$STORAGE_ROOT" == /* ]] || fail "STORAGE_FS_ROOT must be an absolute path (got '$STORAGE_ROOT')"

log "Installing systemd units (storage=$STORAGE_ROOT, home=$APP_HOME, user=$APP_USER)"
for unit in "$HERE"/systemd/gtids-*.service; do
  sed -e "s#/srv/gtids/agreements#${STORAGE_ROOT}#g" \
      -e "s#/opt/gtids-agreements#${APP_HOME}#g" \
      -e "s#^User=gtids\$#User=${APP_USER}#" \
      -e "s#^Group=gtids\$#Group=${APP_USER}#" \
      "$unit" > "/etc/systemd/system/$(basename "$unit")"
  chmod 0644 "/etc/systemd/system/$(basename "$unit")"
done

log "Installing nginx configuration for $SITE"
install -m 0644 "$HERE/nginx/gtids-proxy-params.conf" /etc/nginx/gtids-proxy-params.conf
# http-level directives (rate-limit zones, upstreams), declared once per server.
install -d -m 0755 /etc/nginx/conf.d
install -m 0644 "$HERE/nginx/gtids-http.conf" /etc/nginx/conf.d/gtids-http.conf
rm -f /etc/nginx/conf.d/gtids-limits.conf   # superseded name

# Remove any GTIDS site installed under a previous hostname. Left in place it
# duplicates this server block, and nginx rejects the whole configuration.
for enabled in /etc/nginx/sites-enabled/*; do
  [[ -e "$enabled" ]] || continue
  name="$(basename "$enabled")"
  if [[ "$name" != "$SITE" ]] && grep -q 'GTIDS Agreement Portal' "$enabled" 2>/dev/null; then
    log "Removing superseded GTIDS site: $name"
    rm -f "$enabled" "/etc/nginx/sites-available/$name"
  fi
done
# server_name and the certificate paths must match the real hostname, or nginx
# serves the default site and TLS never loads.
sed "s#agreements\.gtids\.example#${SITE}#g" \
  "$HERE/nginx/gtids-agreements.conf" > "/etc/nginx/sites-available/$SITE"
chmod 0644 "/etc/nginx/sites-available/$SITE"
ln -sfn "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
rm -f /etc/nginx/sites-enabled/default

# `http2 on;` as a standalone directive arrived in nginx 1.25.1. Ubuntu 22.04
# ships 1.18, where HTTP/2 is a parameter of `listen` instead. Rewrite for older
# builds rather than requiring a newer nginx.
NGINX_VER="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [[ -n "$NGINX_VER" ]] && \
   [[ "$(printf '%s\n1.25.1\n' "$NGINX_VER" | sort -V | head -1)" != "1.25.1" ]]; then
  log "nginx $NGINX_VER predates 'http2 on;' — using the listen-parameter form"
  sed -i \
    -e 's#^\( *\)listen 443 ssl;#\1listen 443 ssl http2;#' \
    -e 's#^\( *\)listen \[::\]:443 ssl;#\1listen [::]:443 ssl http2;#' \
    -e '/^ *http2 on;$/d' \
    "/etc/nginx/sites-available/$SITE"
fi

# nginx refuses to load a site whose certificate is missing, and certbot's nginx
# plugin needs the site loaded to prove the domain. Break that circle with a
# self-signed placeholder so nginx starts; the real certificate replaces it.
if [[ ! -f "/etc/letsencrypt/live/$SITE/fullchain.pem" ]]; then
  log "No TLS certificate for $SITE — generating a self-signed placeholder"
  install -d -m 0755 /etc/ssl/gtids
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "/etc/ssl/gtids/$SITE.key" -out "/etc/ssl/gtids/$SITE.crt" \
    -subj "/CN=$SITE/O=Gramtarang Inclusive Development Services/C=IN" \
    -addext "subjectAltName=DNS:$SITE" 2>/dev/null
  chmod 0600 "/etc/ssl/gtids/$SITE.key"

  sed -i \
    -e "s#ssl_certificate     /etc/letsencrypt/live/$SITE/fullchain.pem;#ssl_certificate     /etc/ssl/gtids/$SITE.crt;#" \
    -e "s#ssl_certificate_key /etc/letsencrypt/live/$SITE/privkey.pem;#ssl_certificate_key /etc/ssl/gtids/$SITE.key;#" \
    -e "s#ssl_stapling on;#ssl_stapling off;#" \
    -e "s#ssl_stapling_verify on;#ssl_stapling_verify off;#" \
    "/etc/nginx/sites-available/$SITE"

  printf '\033[33m!!!\033[0m %s\n' "Using a SELF-SIGNED certificate. Browsers will warn."
  printf '\033[33m!!!\033[0m %s\n' "Replace it before go-live:"
  printf '\033[33m!!!\033[0m %s\n' "  certbot --nginx -d $SITE"
  printf '\033[33m!!!\033[0m %s\n' "or install your CA-issued certificate and point the site at it."
fi

log "Installing log rotation"
cat > /etc/logrotate.d/gtids <<'EOF'
/var/log/gtids/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0640 gtids gtids
    sharedscripts
    postrotate
        # The services append to their log files directly; a restart is not
        # wanted just to rotate, so copytruncate semantics are achieved by
        # systemd reopening on SIGHUP where supported.
        systemctl kill -s HUP gtids-api gtids-worker gtids-web 2>/dev/null || true
    endscript
}
EOF

log "Scheduling nightly backup"
cat > /etc/systemd/system/gtids-backup.service <<EOF
[Unit]
Description=GTIDS Agreement Portal — nightly backup

[Service]
Type=oneshot
ExecStart=$HERE/backup.sh
EOF

cat > /etc/systemd/system/gtids-backup.timer <<'EOF'
[Unit]
Description=GTIDS nightly backup

[Timer]
OnCalendar=*-*-* 01:30:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

# Weekly restore verification. A backup nobody has restored is a hypothesis.
cat > /etc/systemd/system/gtids-backup-verify.service <<EOF
[Unit]
Description=GTIDS backup restore verification

[Service]
Type=oneshot
ExecStart=$HERE/backup.sh --verify-restore
EOF

cat > /etc/systemd/system/gtids-backup-verify.timer <<'EOF'
[Unit]
Description=GTIDS weekly restore verification

[Timer]
OnCalendar=Sun *-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload

if nginx -t; then
  # reload-or-restart, not reload: an earlier invalid configuration leaves nginx
  # stopped, and `reload` then fails with "not active, cannot reload" — which
  # reads like a second fault rather than a consequence of the first.
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload-or-restart nginx
  log "nginx configuration valid and $(systemctl is-active nginx)"
else
  echo "nginx configuration is invalid — fix before enabling the site." >&2
  exit 1
fi

systemctl enable gtids-api gtids-worker gtids-web >/dev/null
systemctl enable --now gtids-backup.timer gtids-backup-verify.timer >/dev/null

log "Units installed and enabled (not started — deploy a release first)."
cat <<EOF

Then:
  sudo $HERE/deploy.sh /path/to/checkout

TLS is not configured by this script. Obtain a certificate for $SITE with your
own CA or:
  sudo certbot --nginx -d $SITE
EOF

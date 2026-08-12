#!/usr/bin/env bash
#
# Collect everything needed to explain a failing deployment, in one compact
# report. Read-only.
#
#   sudo ./deploy/server/diagnose.sh
#
# Written because "502 Bad Gateway" is the symptom of about six different causes,
# and guessing between them one round trip at a time is slow.
#
set -uo pipefail

APP_HOME="${APP_HOME:-/opt/gtids-agreements}"
ENV_FILE="${ENV_FILE:-/etc/gtids/api.env}"
API_PORT=3100
WEB_PORT=3101

sec() { printf '\n\033[1m── %s ─────────────────────────────────────────\033[0m\n' "$1"; }
kv()  { printf '  %-22s %s\n' "$1" "$2"; }

printf '\n\033[1mGTIDS deployment diagnosis\033[0m  %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"

sec "Services"
for u in gtids-api gtids-worker gtids-web nginx postgresql redis-server; do
  state="$(systemctl is-active "$u" 2>/dev/null || true)"
  sub="$(systemctl show -p SubState --value "$u" 2>/dev/null || true)"
  result="$(systemctl show -p Result --value "$u" 2>/dev/null || true)"
  kv "$u" "$state${sub:+ / $sub}${result:+ (result: $result)}"
done

sec "Listening ports"
for p in $API_PORT $WEB_PORT 80 443; do
  line="$(ss -ltnp 2>/dev/null | grep -E ":$p " | head -1)"
  kv "$p" "${line:-nothing listening}"
done

sec "Direct upstream checks (bypassing nginx)"
api_code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$API_PORT/api/v1/health" 2>/dev/null || echo 000)"
web_code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)"
kv "API  /health"  "$api_code $([[ $api_code == 000 ]] && echo '(no response — API is down)')"
kv "web  /login"   "$web_code $([[ $web_code == 000 ]] && echo '(no response — web is down)')"
[[ "$api_code" == "200" ]] && { printf '  readiness: '; curl -s -m 5 "http://127.0.0.1:$API_PORT/api/v1/health/ready"; echo; }

sec "Release"
if [[ -L "$APP_HOME/current" ]]; then
  kv "current ->" "$(readlink -f "$APP_HOME/current")"
  kv "api/dist/main.js"    "$([[ -f "$APP_HOME/current/api/dist/main.js" ]] && echo present || echo MISSING)"
  kv "api/dist-db"         "$([[ -d "$APP_HOME/current/api/dist-db/migrations" ]] && echo present || echo MISSING)"
  kv "api/node_modules"    "$([[ -d "$APP_HOME/current/api/node_modules" ]] && echo present || echo MISSING)"
  kv "web/.next"           "$([[ -d "$APP_HOME/current/web/.next" ]] && echo present || echo MISSING)"
  kv "web/node_modules"    "$([[ -d "$APP_HOME/current/web/node_modules" ]] && echo present || echo MISSING)"
  kv "browsers (chromium)" "$([[ -d "$APP_HOME/browsers" ]] && echo present || echo MISSING)"
else
  kv "current" "NOT PRESENT — deploy.sh has never completed a switch"
fi

sec "Configuration"
if [[ -f "$ENV_FILE" ]]; then
  for k in NODE_ENV PORT STORAGE_FS_ROOT PDF_RENDERER ESIGN_PROVIDER SMTP_TRANSPORT API_BASE_URL; do
    kv "$k" "$(grep -E "^$k=" "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
  done
  # Never print the secrets themselves.
  kv "DATABASE_URL role" "$(grep -E '^DATABASE_URL=' "$ENV_FILE" | sed -E 's|.*://([^:]+):.*|\1|')"
else
  kv "$ENV_FILE" "MISSING"
fi

sec "Recent errors — API"
journalctl -u gtids-api -n 25 --no-pager 2>/dev/null | tail -25
[[ -f /var/log/gtids/api.log ]] && { echo "  --- api.log ---"; tail -25 /var/log/gtids/api.log; }

sec "Recent errors — web"
journalctl -u gtids-web -n 15 --no-pager 2>/dev/null | tail -15
[[ -f /var/log/gtids/web.log ]] && { echo "  --- web.log ---"; tail -15 /var/log/gtids/web.log; }

sec "Recent errors — worker"
journalctl -u gtids-worker -n 10 --no-pager 2>/dev/null | tail -10

sec "nginx"
nginx -t 2>&1 | sed 's/^/  /'
[[ -f /var/log/nginx/gtids-error.log ]] && { echo "  --- gtids-error.log ---"; tail -15 /var/log/nginx/gtids-error.log; }

sec "Likely cause"
if [[ ! -L "$APP_HOME/current" ]]; then
  echo "  deploy.sh has never completed. nginx is proxying to nothing."
elif [[ "$api_code" == "000" && "$web_code" == "000" ]]; then
  echo "  Neither upstream is listening. Both services failed to start —"
  echo "  read the journal output above; systemd reports the reason on the"
  echo "  'Failed with result' line."
elif [[ "$api_code" == "000" ]]; then
  echo "  The web UI is up but the API is not, so every page that loads data 502s."
elif [[ "$web_code" == "000" ]]; then
  echo "  The API is up but the web UI is not — a 502 on '/' with a working /api/v1."
else
  echo "  Both upstreams respond directly, so the fault is between nginx and them:"
  echo "  check the proxy_pass targets and gtids-error.log above."
fi
echo

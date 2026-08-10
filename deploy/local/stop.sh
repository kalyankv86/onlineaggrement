#!/usr/bin/env bash
#
# Stop the local deployment. Leaves Postgres and Redis running — they are
# Homebrew services the developer may be using for something else.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$ROOT/.run"
QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

say() { [[ $QUIET -eq 1 ]] || printf '%s\n' "$1"; }

for name in api worker web; do
  pidfile="$RUN/$name.pid"
  [[ -f "$pidfile" ]] || continue
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    # SIGTERM so Nest's shutdown hooks close the database pool cleanly.
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null || true
    say "stopped $name (pid $pid)"
  fi
  rm -f "$pidfile"
done

# Catch anything started outside the pidfiles.
pkill -f 'node dist/main.js' 2>/dev/null || true
pkill -f 'node dist/worker.js' 2>/dev/null || true
pkill -f 'next start -p' 2>/dev/null || true

say "local deployment stopped"

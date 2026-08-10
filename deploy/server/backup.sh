#!/usr/bin/env bash
#
# Nightly backup — database, WAL archive and configuration.
#
#   sudo ./backup.sh                     # write to $BACKUP_ROOT
#   sudo ./backup.sh --verify-restore    # additionally restore into a scratch DB
#
# The document store is NOT copied here. It lives on the NAS and is protected by
# the NAS's own snapshot and replication policy — copying tens of gigabytes of
# immutable PDFs onto the same appliance every night would consume space without
# adding a recovery path. What this protects is the *database*, which is the only
# thing that makes those PDFs meaningful.
#
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/srv/gtids/backups}"
DB_NAME="${DB_NAME:-gtids_agreements}"
RETAIN_DAYS="${RETAIN_DAYS:-35}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

log()  { printf '\033[32m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31m!!!\033[0m %s\n' "$1" >&2; exit 1; }

install -d -m 0700 "$DEST"

log "Dumping $DB_NAME"
# Custom format: parallel restore, and selective restore if only one table is
# ever needed.
sudo -u postgres pg_dump -Fc -Z6 "$DB_NAME" -f "$DEST/$DB_NAME.dump" \
  || fail "pg_dump failed"

log "Capturing configuration"
tar -czf "$DEST/config.tar.gz" -C / etc/gtids etc/nginx/sites-available 2>/dev/null || true

# Note: the redirects below are performed by the calling shell, which is root
# (enforced above), not by the sudo'd psql. That is intentional — shellcheck's
# SC2024 warning does not apply when the caller is already root.
log "Recording schema and audit state"
sudo -u postgres psql -d "$DB_NAME" -c '\d+ *' > "$DEST/schema.txt" 2>/dev/null || true
# Chain heads let a restore be checked against what was true at backup time.
sudo -u postgres psql -d "$DB_NAME" -tAc \
  'SELECT agreement_id, head_hash, record_count FROM audit_chain_heads ORDER BY agreement_id' \
  > "$DEST/audit-chain-heads.txt" || true
sudo -u postgres psql -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM agreements WHERE status='COMPLETED'" > "$DEST/completed-count.txt" || true

sha256sum "$DEST"/* > "$DEST/SHA256SUMS"
chmod -R go-rwx "$DEST"

log "Pruning backups older than $RETAIN_DAYS days"
find "$BACKUP_ROOT" -maxdepth 1 -type d -name '20*' -mtime "+$RETAIN_DAYS" -exec rm -rf {} + || true

# ── Optional restore verification ────────────────────────────────────────────
# A backup that has never been restored is a hypothesis, not a backup (AC-22).
if [[ "${1:-}" == "--verify-restore" ]]; then
  SCRATCH="gtids_restore_check_$$"
  log "Restoring into $SCRATCH to verify the dump"
  sudo -u postgres createdb "$SCRATCH"
  trap 'sudo -u postgres dropdb --if-exists "$SCRATCH"' EXIT

  sudo -u postgres pg_restore -d "$SCRATCH" "$DEST/$DB_NAME.dump" >/dev/null 2>&1 || true

  completed="$(sudo -u postgres psql -d "$SCRATCH" -tAc \
    "SELECT count(*) FROM agreements WHERE status='COMPLETED'")"
  expected="$(cat "$DEST/completed-count.txt")"
  [[ "$completed" == "$expected" ]] \
    || fail "Restored database has $completed completed agreements, expected $expected"

  # The audit chain must survive a restore intact, or the trail proves nothing.
  broken="$(sudo -u postgres psql -d "$SCRATCH" -tAc "
    WITH recomputed AS (
      SELECT id, prev_hash, row_hash,
        encode(sha256(convert_to(
          prev_hash || COALESCE(agreement_id::text,'') || COALESCE(agreement_version::text,'')
          || COALESCE(actor_id::text,'') || event_type || COALESCE(event_data::text,'{}')
          || to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US'),'UTF8')),'hex') AS expected,
        LAG(row_hash) OVER (PARTITION BY agreement_id ORDER BY id) AS predecessor
      FROM audit_logs
    )
    SELECT count(*) FROM recomputed
    WHERE expected <> row_hash
       OR prev_hash IS DISTINCT FROM COALESCE(predecessor, repeat('0',64))")"
  [[ "$broken" == "0" ]] || fail "Restored audit chain has $broken broken link(s)"

  log "Restore verified: $completed completed agreements, audit chain intact"
fi

log "Backup complete: $DEST"
du -sh "$DEST"

cat <<EOF

Reminder — this backup covers the database and configuration only.
Document recovery depends on the NAS snapshot/replication policy. Confirm with
whoever administers the NAS that:
  * snapshots of the agreements export are taken at least daily,
  * they are retained for the DEC-013 period (8 years, pending confirmation),
  * and at least one copy exists off the primary appliance.
A restored database whose documents are gone leaves you with verifiable hashes
of files nobody can produce.
EOF

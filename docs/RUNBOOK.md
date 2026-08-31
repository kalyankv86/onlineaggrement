# Operations Runbook

GTIDS Online Agreement Management & Digital Signing Portal

---

## Processes

Two, deliberately separate (SDD §14):

| Process | Command | Purpose |
|---|---|---|
| API | `node dist/main.js` | HTTP, behind Nginx/WAF, 2+ instances |
| Worker | `RUN_SCHEDULER=true node dist/worker.js` | Scheduled jobs, 1+ instance |

They are separate because Chromium rendering is memory-hungry and email dispatch is
latency-bound; neither should be able to starve an API instance that is serving a signer
mid-ceremony. Running the API with `RUN_SCHEDULER=true` is fine for development and wrong for
production.

---

## Scheduled jobs

Each exists because something can silently stall. When a job stops running, the failure mode
below is what returns.

| Job | Cadence | Guards against | Failure mode if it stops |
|---|---|---|---|
| `dispatchNotifications` | 30 s | Undelivered outbox rows | Parties never learn the agreement completed (BR-008 half-broken) |
| `reconcileSigningTransactions` | 1 min | Lost provider callbacks | Agreements stranded in `AGENT_SIGNING`/`MD_SIGNING` forever (FR-024) |
| `expireOverdueAgreements` | 1 h | Unactioned agreements | The register fills with items nobody is chasing (FR-021) |
| `sendReminders` | 6 h | Silent SLA breach | Parties are never nudged (FR-022) |
| `verifyAuditChains` | daily 02:00 | Undetected audit tampering | Excision by a privileged actor goes unnoticed (FR-025, AC-16) |
| `verifyCompletedDocuments` | daily 03:00 | Storage corruption | A broken signature is discovered by a counterparty in a dispute, not by us |

Monitor: every job logs a one-line summary. Alert on absence of the daily lines, not only on errors.

---

## Alerts that must page someone

| Signal | Meaning | First action |
|---|---|---|
| `AUDIT CHAIN BROKEN` in logs, or `audit-integrity` reporting `intact: false` | Audit records were altered or removed by something holding database privileges | Treat as a security incident. Do not restart anything. Preserve the database. Identify the break point from `brokenAtId` and correlate with database access logs. |
| `SIGNATURE INTEGRITY ALERT` | A previously valid signature stopped verifying | The affected document was **not** persisted — the workflow stopped. Do not retry. Determine whether storage returned different bytes than were written. |
| `document integrity: N failed` from the daily check | A completed agreement's signatures no longer validate | Same as above, but the document is already final. Restore that object from a versioned backup and re-verify. |
| Readiness reports `esignProvider … mock` in production | The application refused to start, or someone overrode the guard | `assertProductionConfig` should have prevented boot. Investigate how it started. |
| Reconciliation recovering transactions repeatedly | Provider callbacks are not reaching us | Check the WAF/proxy path for `/api/v1/esign/callback` and the provider's endpoint configuration. |
| Rising `REJECTED_SIGNATURE` callback outcomes | Forged callbacks, or a rotated provider secret | If the provider rotated its secret, update `ESIGN_CALLBACK_SECRET`. Otherwise treat as an attack. |

---

## Common tasks

### Check whether an agreement is stuck

```sql
SELECT agreement_number, status, updated_at, expires_at
FROM agreements
WHERE status NOT IN ('COMPLETED','CANCELLED','REJECTED','EXPIRED')
  AND updated_at < now() - interval '2 days'
ORDER BY updated_at;
```

Then look at `GET /api/v1/reports/workflow-aging` for the same picture aggregated by state.

### A signing ceremony that never came back

```sql
SELECT t.id, t.provider_transaction_id, t.status, t.initiated_at, a.agreement_number
FROM esign_transactions t JOIN agreements a ON a.id = t.agreement_id
WHERE t.status IN ('INITIATED','PENDING_SIGNER')
  AND t.initiated_at < now() - interval '1 hour';
```

The reconciliation job handles these automatically within a minute. If rows persist beyond
that, the job is not running or the provider is unreachable — check the worker's logs before
touching data.

### Verify an agreement's signatures on demand

```
GET /api/v1/agreements/{id}/verify-signatures
```

Expect `count: 2` and `allValid: true` for a completed agreement. `coversWholeFile: false` on
the **first** signature is correct, not a fault: the Agent signed revision 1, and the Employee
attestation and MD signature were appended afterwards.

### Verify the audit chain

```
GET /api/v1/reports/audit-integrity          # whole register
GET /api/v1/reports/audit-chain?agreementId= # one agreement
```

### Re-send a completion email

Reset the recipient row; the dispatch job picks it up within 30 seconds.

```sql
UPDATE notification_recipients
SET status = 'QUEUED', attempt_count = 0, failure_reason = NULL
WHERE id = '...';
```

Do **not** create a new `notifications` row by hand — completion notifications are written by
the finalisation transaction, and a manual one would not be tied to it.

---

## Logs — where they are and what is in them

| Source | Path | Contains |
|---|---|---|
| API | `/var/log/gtids/api.log` | requests, state transitions, signature results, errors with a correlation id |
| Worker | `/var/log/gtids/worker.log` | job summaries: notifications sent, transactions reconciled, chains verified |
| Web UI | `/var/log/gtids/web.log` | Next.js server output; render and server-action errors |
| nginx | `/var/log/nginx/gtids-access.log`, `gtids-error.log` | requests reaching the server; upstream connection failures |
| PostgreSQL | `/var/log/postgresql/` | slow queries, constraint violations, connection failures |

**`journalctl` will not show you application output.** The units write it to the
files above, so `journalctl -u gtids-api` carries only systemd's own lines —
starts, stops, restarts, failures. Both are useful; they answer different
questions. Use the journal to find out *whether a service restarted and why*, and
the log files to find out *what it did*.

```bash
tail -f /var/log/gtids/api.log                      # follow live
journalctl -u gtids-api -f                          # follow restarts/failures
grep -i error /var/log/gtids/api.log | tail -30
```

### Finding a specific thing

```bash
# Everything about one agreement
grep 'GTIDS/2026-27/SVCAGR/000042' /var/log/gtids/api.log

# A 500 the user reported: they were given a correlation id
grep '\[9oqq28xh\]' /var/log/gtids/api.log

# Did the worker actually start its jobs?
grep 'scheduled job' /var/log/gtids/worker.log | tail -1

# Signature integrity alerts — always worth investigating
grep -i 'SIGNATURE INTEGRITY' /var/log/gtids/*.log

# Requests that reached nginx but failed upstream
grep -v ' 200 ' /var/log/nginx/gtids-access.log | tail -20
```

### What is deliberately *not* in the logs

The legally significant record is the **audit trail in the database**, not these
files. Logs are rotated daily and kept 30 days; the audit trail is hash-chained,
append-only and retained for the DEC-013 period. Never reason about who signed
what from a log file:

The reporting and audit endpoints require an authenticated auditor. Obtain a
token first — they are not open, which is the point:

```bash
TOKEN=$(curl -s -X POST localhost:3100/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"auditor@gtids.example","password":"<password>"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

# Chain health across the whole register
curl -s -H "Authorization: Bearer $TOKEN" \
  localhost:3100/api/v1/reports/audit-integrity

# The trail for one agreement
curl -s -H "Authorization: Bearer $TOKEN" \
  localhost:3100/api/v1/agreements/<id>/audit
```

A token lasts 30 minutes. If the call returns `401 Bearer token required`, it has
expired — request another.

Aadhaar numbers and OTP values appear in no log by design (SRS §12, AC-21).

### Rotation

Daily, 30 kept, compressed, via `/etc/logrotate.d/gtids`. To check it is working:

```bash
logrotate -d /etc/logrotate.d/gtids     # dry run, shows what it would do
ls -la /var/log/gtids/
```

---

## Things not to do

- **Never `UPDATE` or `DELETE` `audit_logs`.** Three layers will stop you, and the third
  (the hash chain) will record that you tried. If a record is genuinely wrong, append a
  correcting record.
- **Never modify a stored PDF in place.** Every object is write-once. A new state produces a
  new object. In-place edits break signatures.
- **Never disable a trigger in production.** The test harness does this against the test
  database only, and that is the only place it is acceptable.
- **Never bypass `WorkflowService` to set `agreements.status`.** It is the only component
  permitted to write that column; direct updates skip the transition log, the audit record and
  the row lock.
- **Never re-run the seed against production.** It refuses on `NODE_ENV=production`, but do
  not test that.

---

## Backup and restore (SRS §11, AC-22)

- Postgres: PITR enabled, RPO ≤ 15 minutes.
- Object storage: versioning on, retention lock for the DEC-013 period.
- Restore is tested quarterly, into a clean environment, and the test is not complete until
  `GET /api/v1/reports/audit-integrity` reports `intact: true` and a sample of completed
  agreements re-verify their signatures. A backup that restores rows but not verifiable
  documents has not been tested.

---

## Configuration guardrails

`assertProductionConfig` refuses to start production if any of these are still set:

- `ESIGN_PROVIDER=mock`
- `STORAGE_DRIVER=filesystem`
- `SMTP_TRANSPORT=json`
- `PDF_RENDERER` not `playwright`
- `JWT_SECRET` or `ESIGN_CALLBACK_SECRET` containing a placeholder

If production fails to boot, read that error first — it is almost certainly telling you the truth.

---

## Escalation

| Class | Examples |
|---|---|
| Security incident | Audit chain break, signature integrity alert, forged callbacks |
| Legal exposure | A completed agreement whose signatures no longer validate |
| Operational | Stuck agreements, undelivered email, provider outage |

Provider outages degrade to queued retry and are recovered by reconciliation. They are
operational, not legal — no data is lost and no agreement is falsely completed.

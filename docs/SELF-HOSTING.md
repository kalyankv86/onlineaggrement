# Self-Hosting Guide

GTIDS Online Agreement Management & Digital Signing Portal, on GTIDS-owned
infrastructure. No cloud services, no Docker, no object-store product — one Linux
server and a NAS export.

---

## Topology

```
                    ┌─────────────────────────────────────────┐
   Internet ──443──►│ nginx (single ingress, TLS terminator)  │
                    │   /            → web  :3101             │
                    │   /api/v1/*    → api  :3100             │
                    └──────────┬──────────────────────────────┘
                               │  (127.0.0.1 only)
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
  ┌─────▼──────┐        ┌──────▼──────┐        ┌──────▼──────┐
  │ gtids-web  │        │  gtids-api  │        │gtids-worker │
  │  Next.js   │        │   NestJS    │        │  scheduled  │
  └────────────┘        └──────┬──────┘        └──────┬──────┘
                               │                      │
              ┌────────────────┼──────────────────────┤
              │                │                      │
        ┌─────▼─────┐   ┌──────▼──────┐        ┌──────▼───────────┐
        │PostgreSQL │   │    Redis    │        │  NAS export      │
        │ 127.0.0.1 │   │  127.0.0.1  │        │  /srv/gtids/…    │
        └───────────┘   └─────────────┘        │  (NFS, mounted)  │
                                               └──────────────────┘
```

Only nginx is exposed. Postgres, Redis and both Node processes bind to loopback.

The API and worker are separate units on purpose: PDF rendering runs Chromium and
is memory-hungry, and the worker also holds the reconciliation and integrity jobs.
Neither should be able to starve a request that is serving a signer mid-ceremony.

---

## Installation

### Before you start

| Requirement | Notes |
|---|---|
| Ubuntu 22.04/24.04 LTS or Debian 12 | 4 vCPU / 8 GB / 40 GB local disk is comfortable |
| Root (sudo) access | |
| NAS export reachable from the server | NFSv4 preferred; **must support hard links** |
| DNS A record for the public hostname | pointing at this server |
| Outbound HTTPS | the deploy builds on the server and needs the npm registry |
| SMTP relay credentials | GTIDS mail server |

Set these once and reuse them in every command:

```bash
export SITE=agreements.gtids.org                     # your public hostname
export NAS_EXPORT=nas.gtids.local:/volume1/agreements # your export
export STORAGE_ROOT=/srv/gtids/agreements            # the mountpoint
```

### 1 — Get the code onto the server

```bash
sudo install -d -o "$USER" /opt/src
git clone https://github.com/kalyankv86/onlineaggrement.git /opt/src/gtids-agreements
cd /opt/src/gtids-agreements
```

(Or `rsync -a --exclude node_modules ./ server:/opt/src/gtids-agreements/`.)

### 2 — Provision

```bash
sudo -E ./deploy/server/provision.sh
```

Installs packages, Node 22, Chromium's runtime libraries, the `gtids` service
user, PostgreSQL (with WAL archiving), Redis (with AOF), the firewall, the fstab
entry for the NAS, and a generated `/etc/gtids/api.env`.

`-E` matters: it passes your `SITE`, `NAS_EXPORT` and `STORAGE_ROOT` through sudo.

### 3 — Confirm the NAS

```bash
mountpoint "$STORAGE_ROOT" && ls -la "$STORAGE_ROOT/.gtids-storage-root"
```

Both must succeed. If the export was not mounted when provisioning ran, mount it
and create the marker:

```bash
sudo mount "$STORAGE_ROOT"
sudo -u gtids touch "$STORAGE_ROOT/.gtids-storage-root"
```

### 4 — Fill in the secrets

```bash
sudo nano /etc/gtids/api.env
```

Set `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD`, and `ESIGN_PROVIDER` once the ESP
is contracted. `JWT_SECRET`, `ESIGN_CALLBACK_SECRET` and both database passwords
were generated for you — leave them alone.

### 5 — Install units, nginx, timers

```bash
sudo -E ./deploy/server/install-units.sh
```

The hostname and storage path are substituted into the nginx site and the systemd
units from `SITE` and `/etc/gtids/api.env`, so nothing is hardcoded.

### 6 — TLS

`install-units.sh` leaves a self-signed placeholder so nginx can start. Replace it.

**If the host is reachable from the internet on port 80** — the site config already
serves `/.well-known/acme-challenge/` from `/var/www/html`, so use the webroot
method rather than `--nginx`, which rewrites the site file:

```bash
sudo mkdir -p /var/www/html
sudo certbot certonly --webroot -w /var/www/html -d "$SITE" \
  --deploy-hook "systemctl reload nginx"

# re-run so nginx points at the real certificate instead of the placeholder
sudo -E ./deploy/server/install-units.sh
```

**If it is only reachable internally**, HTTP-01 cannot work — the challenge comes
from the public internet. Two options:

```bash
# DNS-01: proves control of the domain with a TXT record, no inbound access
sudo certbot certonly --manual --preferred-challenges dns -d "$SITE"
```

or install your own CA-issued certificate at
`/etc/ssl/gtids/$SITE.{crt,key}`, which is where the site already points when no
Let's Encrypt certificate exists.

Renewal is handled by certbot's own systemd timer. Check it with
`systemctl list-timers | grep certbot` and rehearse it with
`certbot renew --dry-run`.

### 7 — Preflight

```bash
sudo -E ./deploy/server/preflight.sh
```

Read-only. It checks the NAS is mounted, the marker exists, **hard links work on
the share**, Redis has AOF on, WAL archiving is on, the app connects as
`gtids_app`, and the configuration has no placeholders left. Exit code 0 means
ready. Fix every ✗ before continuing.

### 8 — Deploy

```bash
sudo ./deploy/server/deploy.sh /opt/src/gtids-agreements
```

Builds into a timestamped release, installs Chromium, migrates, switches the
`current` symlink, restarts in dependency order, and **rolls back automatically**
if readiness does not come up. `deploy.sh --rollback` returns to the previous
release.

### 9 — Verify

```bash
curl -s localhost:3100/api/v1/health/ready | jq     # storage + database + provider
systemctl status gtids-api gtids-worker gtids-web
curl -sI "https://$SITE/login" | head -1
```

### 10 — Create the first administrator

Production has no seeded users — the seed refuses to run with
`NODE_ENV=production`, because demo accounts with a published password have no
business in a register of legal instruments. The roles themselves *are* created,
by migration, so the system is usable the moment you add a person:

```bash
cd /opt/gtids-agreements/current/api
sudo -u gtids bash -c 'set -a && . /etc/gtids/api.env && set +a && \
  node dist/scripts/create-user.js \
    --email ops@gtids.org --name "A. Nayak" --role SUPER_ADMIN'
```

A strong password is generated and printed **once**. Deliver it out of band and
have the holder change it. Re-running for the same email updates the account and
adds roles rather than duplicating it; `--deactivate` disables one.

Then sign in at `https://$SITE/login` and create the remaining people, the
agreement type and the first template.

### Upgrading later

```bash
cd /opt/src/gtids-agreements && git pull
sudo ./deploy/server/preflight.sh
sudo ./deploy/server/deploy.sh /opt/src/gtids-agreements
```

---

## Installing before the NAS is available

If the mount is scheduled for a later window, everything else can be provisioned,
deployed and validated now. Two rules make that safe.

**Use a different path for the interim.** Not the future mountpoint. If documents
are written to `/srv/gtids/agreements` on local disk and the NAS is later mounted
*there*, every one of them is shadowed by the mount — still on disk, unreachable,
and the database holds hashes for files nobody can read. That is precisely the
failure the marker file exists to prevent, arrived at from the other direction.

**Run it as staging, not production.** `NODE_ENV=production` requires the marker
and refuses to start without it — correctly. Staging skips that guard, which is
right for validation and wrong for anything you need to keep.

```bash
# /etc/gtids/api.env — while the NAS is pending
NODE_ENV=staging
STORAGE_FS_ROOT=/var/lib/gtids/agreements-staging
```

```bash
install -d -o gtids -g gtids -m 0750 /var/lib/gtids/agreements-staging
./deploy/server/preflight.sh --staging     # NAS + provider checks advisory
./deploy/server/deploy.sh /opt/src/gtids-agreements
```

In this state you can exercise the whole workflow, confirm the PDF pipeline and
signatures, check mail delivery and train users. **Do not execute agreements you
need to keep** — they are on local disk, outside the backup and retention policy.

### Cutting over when the NAS arrives

```bash
systemctl stop gtids-api gtids-worker gtids-web

mount /srv/gtids/agreements                       # per your fstab entry
mountpoint /srv/gtids/agreements                  # must succeed
sudo -u gtids touch /srv/gtids/agreements/.gtids-storage-root

# Only if staging produced documents worth keeping:
rsync -a --info=progress2 /var/lib/gtids/agreements-staging/ /srv/gtids/agreements/

sed -i 's|^NODE_ENV=.*|NODE_ENV=production|' /etc/gtids/api.env
sed -i 's|^STORAGE_FS_ROOT=.*|STORAGE_FS_ROOT=/srv/gtids/agreements|' /etc/gtids/api.env

./deploy/server/preflight.sh                       # the real gate now
systemctl start gtids-api gtids-worker gtids-web
curl -s localhost:3100/api/v1/health/ready | jq
```

The file keys in the database are relative to the storage root, so a straight copy
preserves them — no database change is needed. Verify afterwards with
`/api/v1/reports/audit-integrity` and by opening a completed agreement.

---

## The NAS is the part to get right

Executed agreements are the record. Everything else can be rebuilt.

### The failure that matters

If the NAS export is not mounted, the mountpoint is an ordinary empty directory on
the server's local disk. Writes succeed. Agreements get signed. Then the NAS
remounts and every document written in the meantime disappears from view — still
on the local disk, shadowed, invisible, and absent from any backup.

The guard is a marker file that lives **on the NAS**:

```bash
/srv/gtids/agreements/.gtids-storage-root
```

- The API **refuses to start** in production if it is missing.
- `put()` **refuses to write** if it is missing.
- `/api/v1/health/ready` reports `storage: not mounted`, so the load balancer
  stops sending traffic to an instance that cannot reach the documents.

If you ever legitimately move the export, recreate the marker on the new share.
Do not create it on the local disk to "make the error go away" — that reinstates
exactly the failure it exists to prevent.

### Mount options

```
nas.gtids.internal:/volume1/agreements  /srv/gtids/agreements  nfs
    rw,hard,intr,noatime,vers=4.1,_netdev  0  0
```

`hard` matters. With `soft`, a transient network blip returns an I/O error and a
signed agreement can be lost; with `hard` the write blocks and completes when the
NAS returns. `_netdev` and the unit's `RequiresMountsFor` stop the service racing
the mount at boot.

### How writes are made durable

Each object is written to a temporary file, `fsync`ed, then **hard-linked** into
its final name, and the directory is `fsync`ed.

`link()` fails with `EEXIST` if the target exists, which gives an atomic exclusive
create that is reliable over NFS — where `O_EXCL` on open historically was not.
That single mechanism delivers three properties at once: write-once enforcement,
no partially written document ever visible under its real name, and a safe
outcome when two workers race the same key.

### What the NAS must provide

The application cannot supply these; confirm them with whoever runs the appliance:

| Requirement | Why |
|---|---|
| Daily snapshots of the export | The only recovery path for documents |
| Snapshot retention for the DEC-013 period (8 years, pending confirmation) | Legal retention |
| At least one copy off the primary appliance | A snapshot on the failed device is not a backup |
| Encryption at rest on the volume | SRS §12 — there is no application-level encryption |
| Export restricted to the application server's address | Nothing else should reach the documents |

There is deliberately **no `delete`** in the storage interface. Retention is the
NAS's job, so no application bug can destroy evidence.

---

## Backups

`gtids-backup.timer` runs nightly at 01:30; `gtids-backup-verify.timer` runs a real
restore every Sunday at 03:30.

What is backed up: the **database**, the WAL archive (PITR, RPO ≤ 15 min via
`archive_timeout`), and `/etc/gtids`.

What is not: the documents. They are immutable, they are already on the NAS, and
copying them nightly onto the same appliance would consume space without adding a
recovery path.

The weekly verification restores the dump into a scratch database and asserts two
things: the completed-agreement count matches what was true at backup time, and
**every audit hash chain still verifies**. A restore that produces rows but breaks
the chain has not preserved the audit trail, and that is worth knowing on a Sunday
rather than during a dispute.

---

## Secrets

`/etc/gtids/api.env`, mode `0640`, owned `root:gtids`. `provision.sh` generates
the JWT and callback secrets with `openssl rand`; the database passwords are
generated and written in the same step.

Two database roles, and the distinction is load-bearing:

| Role | Used by | Privileges |
|---|---|---|
| `gtids_owner` | migrations only (`MIGRATION_DATABASE_URL`) | owns the schema |
| `gtids_app` | the running application (`DATABASE_URL`) | no `UPDATE`/`DELETE` on `audit_logs` |

If the application is pointed at the owner role, the first of the three layers
protecting the audit trail silently stops applying. The trigger and hash chain
still hold, but do not give away a defence for free.

Rotating `JWT_SECRET` invalidates every session **and** every outstanding external
party access link, because the signed-URL HMAC is derived from it. Rotate during a
quiet window and expect signers mid-ceremony to need a fresh link.

---

## Go-live checklist

- [ ] `preflight.sh` exits 0
- [ ] NAS mounted, marker file present, hard links supported, snapshot policy confirmed in writing
- [ ] First administrator created with `create-user.js`; the generated password was changed
- [ ] `DATABASE_URL` uses `gtids_app`, not `gtids_owner`
- [ ] `ESIGN_PROVIDER` is the contracted ESP — **not** `mock` (DEC-002)
- [ ] `PDF_RENDERER=playwright` and `npx playwright install chromium` has run
- [ ] `SMTP_TRANSPORT=smtp` with working credentials; a test mail was received
- [ ] `API_BASE_URL` and `PUBLIC_VERIFY_BASE_URL` are the public HTTPS hostname,
      and `PUBLIC_VERIFY_BASE_URL` points at the **web** `/verify` path — a QR that
      resolves to raw JSON is a bad first impression for a counterparty
- [ ] TLS certificate installed; HTTP redirects to HTTPS
- [ ] Callback route restricted to the provider's egress addresses in nginx
- [ ] `curl https://…/api/v1/health/ready` reports `ready` with storage ok
- [ ] Backup timers enabled; one restore verification has actually run
- [ ] Audit integrity report is green: `/api/v1/reports/audit-integrity`
- [ ] An end-to-end agreement executed on the server and verified by QR
- [ ] The resulting PDF opened in Adobe Acrobat Reader and both signatures shown
      valid (the outstanding manual step for AC-10)

`assertProductionConfig` blocks startup on several of these — mock provider,
JSON mail transport, non-Playwright renderer, placeholder secrets, a relative or
temporary `STORAGE_FS_ROOT`. If production will not boot, read that error first; it
is telling you the truth.

---

## Operating

```bash
systemctl status gtids-api gtids-worker gtids-web
journalctl -u gtids-api -f
tail -f /var/log/gtids/api.log

curl -s localhost:3100/api/v1/health/ready | jq
```

Day-to-day procedures, alert meanings and incident response are in
[RUNBOOK.md](RUNBOOK.md). The storage-specific alert to add to monitoring:

| Signal | Meaning | Action |
|---|---|---|
| `ready` reports `storage: not mounted` | The NAS export dropped | Remount. Do not create the marker locally. Agreements signed while it was down will have failed loudly rather than been lost. |
| `only N MB free on the storage volume` | Below the 512 MB floor | Extend the export before it stops accepting agreements |

---

## What is deliberately absent

- **No object-store service.** Documents are files on the NAS.
- **No cloud dependency** of any kind.
- **No container runtime.** systemd units on the host.
- **No application-level encryption at rest.** That obligation is met by the NAS
  volume's encryption; if the appliance does not encrypt, raise it, because
  nothing in the application compensates.

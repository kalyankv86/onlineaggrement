# GTIDS Online Agreement Management & Digital Signing Portal

Digitises the agreement lifecycle from initiation and stamping through sequential signing,
approval, finalisation, notification and verification.

**Workflow:** Agent signs → MD signs → email to the agent, the MD and accounts (DEC-024).
**Key design decision:** GTIDS is the system of record. The Aadhaar eSign provider is an
external identity/signature dependency only, isolated behind an adapter.

---

## Current status

| Area | State |
|---|---|
| SRS / SDD review | Complete — 30 gaps and decisions raised ([register](docs/DECISION-REGISTER.md)) |
| SRS v1.1 / SDD v1.1 amendments | Drafted, awaiting GTIDS approval |
| **Phase 2 gate (DEC-001, AC-10)** | ✅ **PASSED** — see [spike](spike/pdf-signing/README.md) |
| API | Built, boots, **133 tests passing** |
| Web UI | Built — **11 browser tests passing** against the running stack |
| Local deployment | ✅ Running: API + worker + web, one command, no Docker |
| Server deployment | Artifacts complete — see [SELF-HOSTING.md](docs/SELF-HOSTING.md) |
| Storage | GTIDS NAS export. No object store, no cloud. **POC runs on local staging storage until the mount window** |
| PDF renderer | Playwright/Chromium, verified through the full signing pipeline |
| eSign provider | Mock only — DEC-002 is the outstanding blocker |

Three of four Phase 0 blockers are resolved in code under stated assumptions.
**DEC-002 (which ESP/ASP GTIDS contracts) is still open and gates production.**

A complete agreement has been executed end to end through the deployed stack — created,
stamped, composed from an uploaded document, signed by the Agent, signed by the MD, notified,
audited and publicly verified — with both signatures independently confirmed valid by poppler's
`pdfsig`.

---

## Repository layout

| Path | Contents |
|---|---|
| [docs/DECISION-REGISTER.md](docs/DECISION-REGISTER.md) | Every gap and open decision, with severity, owner and proposed resolution |
| [docs/SRS-v1.1-amendments.md](docs/SRS-v1.1-amendments.md) | Insertable amendments to SRS v1.0 |
| [docs/SDD-v1.1-amendments.md](docs/SDD-v1.1-amendments.md) | Insertable amendments to SDD v1.0 |
| [docs/ERD.md](docs/ERD.md) | Data model, enums, and the invariants enforced at the database |
| [docs/openapi.yaml](docs/openapi.yaml) | OpenAPI 3.1 specification |
| [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) | Installing on a GTIDS server with NAS storage |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operating the system: jobs, alerts, incident response |
| [spike/pdf-signing/](spike/pdf-signing/) | The Phase 2 gate — proves multi-signature integrity |
| [api/](api/) | NestJS API, migrations, seeds, tests |
| [web/](web/) | Next.js portal, browser tests, [screenshots](web/screenshots/) |
| [deploy/local/](deploy/local/) | One-command local deployment |
| [deploy/server/](deploy/server/) | Provisioning, systemd units, nginx, deploy/rollback, backups |

---

## Running it locally

No Docker. You need PostgreSQL 16 and Redis, both available via Homebrew.

```bash
./deploy/local/start.sh
```

That starts Postgres and Redis if they are not running, creates the databases, migrates, seeds,
builds, and brings up the same three-process topology as production:

| | |
|---|---|
| **Portal** | http://localhost:3101 |
| **API** | http://localhost:3100 |
| Worker | notifications, reconciliation, SLA sweep, integrity checks |

Sign in with any seeded user — `agent@gtids.example`, `employee@gtids.example`,
`md@gtids.example`, `ops@gtids.example`, `admin@gtids.example`, `auditor@gtids.example` —
password `ChangeMe-Dev-2026!`.

```bash
./deploy/local/stop.sh                     # stop
PORT=3200 WEB_PORT=3201 ./deploy/local/start.sh   # if the defaults are taken
```

The API and worker run as separate processes even locally, because that separation is what
stops a PDF render from starving a request that is serving a signer mid-ceremony.

### Walk the whole workflow without clicking

```bash
npm --prefix api run demo
```

Drives Agent → MD over HTTP as each principal, asserts every acceptance criterion
along the way, and writes the executed PDF to `api/demo-output/`.

### Tests

```bash
npm --prefix api test          # 133 — unit, integration against real Postgres, API E2E
npm --prefix web run test:e2e  # 11 — real browser, clicking through the portal
cd spike/pdf-signing && node run.js   # the Phase 2 signature gate
```

The browser suite needs the stack running (`./deploy/local/start.sh`); everything else is
self-contained.

---

## What the design turns on

### 1. Signing is append-only, and that is not optional

SRS §8 forbids invalidating an earlier signature, while the workflow applies two signatures to
one document. Those two requirements are only compatible one way: the document is composed
**once**, both signature widgets are reserved before any signature exists, and every subsequent
action is a **PDF incremental update**.

The consequence is load-bearing: after `prepared-unsigned.pdf` exists, nothing may rewrite the
bytes. Chromium and `pdf-lib.save()` both rewrite the whole file and would destroy every prior
signature. Only `documents/pdf/incremental-signer.ts` may touch a prepared document.

Proven end to end, with poppler's `pdfsig` — code outside this project — confirming both
signatures valid on the final document, and a tamper control confirming detection.

### 2. Sequencing is structural, not a guard

`BR-003` (no MD signature before the agent has signed) is not a check that could be forgotten.
`PENDING_MD_SIGNATURE` has exactly one inbound edge, from `AGENT_SIGNED`, so the ordering cannot
be violated even by a caller reaching the service directly. Unit tests assert both that edge and
the absence of any route into the withdrawn Employee states (DEC-024).

### 3. Documents live on the NAS, and an unmounted share is the thing to fear

If the export is not mounted, the mountpoint is an ordinary empty directory on the
server's local disk. Writes succeed, agreements get signed, and when the NAS returns
every document written in the meantime is shadowed, invisible, and in no backup.

A marker file that lives **on the NAS** makes that detectable: the API refuses to
start without it, refuses to write without it, and reports it in readiness so an
instance that cannot see the documents stops receiving signers.

Each object is written to a temporary file, `fsync`ed, then **hard-linked** into
place. `link()` fails with `EEXIST` if the target exists, which is an atomic
exclusive create that holds over NFS where `O_EXCL` historically did not — one
mechanism giving write-once enforcement, no partially written document ever
visible under its real name, and a safe outcome when two workers race the same key.

### 4. The guarantees that matter live in the database

Application code can be bypassed by the next feature. These cannot:

| Guarantee | Mechanism |
|---|---|
| One live allocation per stamp (BR-006) | partial unique index — verified under 50 concurrent attempts |
| Audit records are append-only (BR-009) | privilege revoke + rejecting trigger + hash chain |
| Audit tampering is detectable (FR-025) | chain computed *by the database* on insert; verified in SQL |
| Completed agreements are frozen (BR-005) | rejecting trigger on `agreements` |
| Documents are write-once | rejecting trigger + unique `file_key` |
| Callback replay is harmless (FR-023) | unique `provider_event_id` |
| Agreement numbers have no gaps (FR-026) | locked counter, not a sequence |

### 5. The provider is replaceable, and a test enforces it

No module outside `src/esign/providers/` may name a vendor, construct a provider, or import
the PKCS#7 helper. `test/unit/provider-isolation.spec.ts` greps the source tree and fails the
build if that stops being true.

### 6. Two-phase signing, because a ceremony is not a function call

The signer leaves for the ESP, authenticates with an OTP, and the result arrives later on a
webhook — possibly at a different API instance. So phase 1 appends the signature revision with
an empty gap, publishes the digest, and parks the bytes in object storage; phase 2 embeds the
returned PKCS#7 and re-verifies every signature. A reconciliation job recovers any ceremony
whose callback never arrives.

---

## The portal

Server-rendered Next.js. The session token lives in an httpOnly cookie and every mutation is a
server action, so the bearer token never reaches browser JavaScript — an injected script cannot
sign an agreement on the user's behalf.

What a user may do comes from `availableActions`, which the API derives from the transition
table. The UI never decides authority itself; if it did, it would drift from the state machine
and the disagreement would surface as a confusing refusal rather than a hidden button. That is
why the Employee genuinely sees no approve button before the Agent has signed.

Screens: sign-in (staff password or external one-time link), agreement list with SLA overdue
highlighting, agreement detail (progress rail, document hash, per-signature verdicts, parties,
stamp, versions, QR, audit trail), creation wizard, stamp inventory, templates, reports, and the
public verification page.

## What is not done

Stated plainly, because scaling the work down is GTIDS's call, not ours:

- **The real eSign adapter** — blocked on DEC-002. `MockEsignProvider` is hash-based and
  exercises the same code path, so swapping in the contracted ESP is one class and one case
  in `esign.module.ts`.
- **UI for template authoring and MD delegation** — both are API-complete; the portal shows
  templates read-only and has no delegation screen yet.
- **Accessibility audit** — the markup is semantic and keyboard-navigable, but WCAG 2.1 AA
  (DEC-022) has not been formally tested.
- **DigiLocker (FR-008)** — deliberately deferred to v1.1 per DEC-017. Schema and module
  boundary ship unwired.
- **Identity module (FR-007)** — narrowed by DEC-005 and not built; it may drop out of v1
  entirely if GTIDS requires no pre-signature KYC.
- **MFA (SRS §12)** — the `users.mfa_secret` column exists; enrolment and challenge are not built.
- **PAdES LTV** — embedded OCSP/CRL and document timestamps. Needed if agreements must remain
  verifiable after the signing certificate expires; raise with GTIDS legal alongside the
  8-year retention assumption (DEC-013).
- **Adobe Acrobat sign-off for AC-10** — `pdfsig` validates the signatures automatically, but
  the manual Acrobat check remains open. Open `spike/pdf-signing/out/5-final-md-signed.pdf`.

`assertProductionConfig` refuses to start production while any of the development choices
(mock provider, JSON mail transport, pdflib renderer, placeholder secrets, or a relative
or temporary STORAGE_FS_ROOT)
are still in place.

---

## Assumptions used where GTIDS input is pending

These are interim values chosen so work could proceed. They are flagged in the decision
register and need GTIDS numbers before UAT:

| Assumption | Value | Decision |
|---|---|---|
| Volume design point | 200 agreements/day, 600 peak, 25 concurrent users | DEC-012 |
| Retention | Documents and audit 8 years; identity refs 1 year; email bodies 90 days | DEC-013 |
| Stage SLA | 14 days per stage, reminders at day 3/7/12 | DEC-008 |
| Agreement numbering | `GTIDS/{FY}/{TYPE}/{6-digit}` | DEC-018 |
| Agent identity | Both internal accounts and external magic links supported | DEC-003 |
| Employee approval | Attested click, not an eSign signature | DEC-004 |

---

## Next steps

1. **Close DEC-002.** Select the ESP/ASP, sign the contract, obtain sandbox credentials.
   Confirm the provider supports multiple sequential signatures on one PDF and tell us its
   callback signing method. This is the only remaining blocker.
2. **Get GTIDS legal sign-off** on DEC-004 (approval is not a signature), DEC-014 (MD
   delegation binds GTIDS) and DEC-015 (physical stamp custody).
3. **Quantify DEC-012 and DEC-013** so the deployment can be sized and the retention policy set.
4. **Approve SRS v1.1 and SDD v1.1.**
5. Then: the real adapter, the web UI, and the Phase 6 security and load work.

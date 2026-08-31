# GTIDS Online Agreement Portal — Gap & Decision Register

**Version:** 1.0
**Date:** 09 August 2026
**Status:** Open — Phase 0 gate
**Source documents:** SRS v1.0, SDD v1.0

This register tracks every specification gap and open decision identified by review of
SRS v1.0 and SDD v1.0. **Phase 0 does not close until every BLOCKER is Decided.**

Legend — Severity: `BLOCKER` (cannot start dependent code) · `HIGH` (rework if deferred) ·
`MEDIUM` (can be defaulted, must be confirmed before UAT) · `LOW` (document only).
Status: `OPEN` · `PROPOSED` (default assumed, in code) · `DECIDED`.

---

## A. Blockers — must be closed before Phase 1 code

### DEC-001 — PDF signature layering strategy
**Severity:** BLOCKER · **Status:** ✅ **VALIDATED** (spike passed 09 Aug 2026) · **Owner:** Tech Lead
**Affects:** SRS §8, FR-009, FR-010, FR-011, FR-013; SDD §2 (PDF Engine), §11
**Blocks:** Document Module, eSign Module, entire Phase 2

SRS §8 requires that the portal never modify a signed PDF in a way that invalidates an
earlier signature. The workflow applies three actions to one document. SDD §2 nominates
Playwright/Chromium as the PDF engine — which renders HTML to PDF but cannot create AcroForm
signature fields or apply PKCS#7 signatures.

**Proposed decision (implemented in code):** two-stage pipeline.
1. Playwright/Chromium renders template + data + stamp → flat PDF.
2. `pdf-lib` post-processes that PDF to add **three pre-placed signature widgets**
   (`GTIDS_Agent`, `GTIDS_Employee`, `GTIDS_MD`) before any signature exists.
3. Each signature is applied as a **PDF incremental update** (append-only byte range),
   never a re-render. Prior signatures stay cryptographically valid.

**Consequences:** the unsigned v1 PDF is immutable once generated; nothing may be appended to
it except via incremental update. Any "approval stamp" drawn on the page must be part of the
v1 render or be rendered into the reserved widget.

**Verification: PASSED.** `spike/pdf-signing` (run `node run.js`). Agent signature + Employee
attestation + MD signature applied as three incremental updates; byte-for-byte prefix equality
asserted after every step; both cryptographic signatures independently confirmed valid by
poppler `pdfsig` ("Signature is Valid." ×2); tamper negative-control correctly rejected.
Observed PKCS#7 size 1,367 B against 8,192 B reserved. Remaining for full AC-10 sign-off:
manual confirmation in Adobe Acrobat Reader.

---

### DEC-002 — eSign provider model: ASP vs ESP, hash-based vs document-based
**Severity:** BLOCKER · **Status:** OPEN · **Owner:** GTIDS Management + Tech Lead
**Affects:** SRS §8, FR-007, FR-011, FR-013; SDD §10
**Blocks:** Phase 4; procurement lead time 2–4 weeks

Aadhaar eSign under IT Act 2000 §3A / Second Schedule is performed by a CCA-licensed ESP
(eMudhra, Protean/NSDL, (n)Code Solutions), normally consumed through an ASP/aggregator
(Digio, Leegality, SignDesk, Setu). GTIDS is the ASP in this architecture.

The decision determines the adapter contract:

| Model | Flow | Impact on SDD §10 |
|---|---|---|
| **Hash-based (typical eSign 2.1)** | GTIDS computes the PDF ByteRange digest, sends the hash, receives a PKCS#7 signature blob, embeds it locally | `getSignedDocument()` is **not used**; add `embedSignature(pkcs7)` |
| **Document-based (aggregator-hosted)** | GTIDS uploads the whole PDF, provider hosts the signing ceremony and returns a signed PDF | `getSignedDocument()` used as specified; GTIDS loses control of field placement |

SDD §10 currently assumes the document-based model. The hash-based model is the one that
satisfies DEC-001 cleanly, because GTIDS keeps control of the incremental update.

**Required actions:** (a) select provider, (b) obtain sandbox credentials, (c) confirm the
provider supports multiple sequential signatures on one PDF, (d) confirm callback signing
method (HMAC/ mTLS / IP allowlist) for DEC-010.

**Interim:** the code ships with `MockEsignProvider` implementing the hash-based interface, so
all workflow development proceeds without the provider. Swapping in the real adapter is a
single module binding.

---

### DEC-003 — Agent identity class: internal user or external counterparty
**Severity:** BLOCKER · **Status:** PROPOSED · **Owner:** GTIDS Management
**Affects:** FR-001, FR-004, §4 Actors; SDD §3 (Auth & RBAC)
**Blocks:** auth module design, Phase 1b

SRS FR-001 says "authenticate **internal** users", but the Agent is described as an agreement
counterparty executing on ₹100 stamp paper — normally an external party. The two readings give
incompatible auth designs:

- **Internal:** Agent has a password account, MFA policy, appears in `users`, is provisioned by
  an admin before an agreement can exist.
- **External:** Agent is a row in `agreement_parties` only, reached by a single-use, expiring,
  signed magic link sent to their email/mobile; no standing credential.

**Proposed decision (implemented in code):** support **both**, via a `party_access_mode` on the
agreement type. `users` carries `user_type ∈ {INTERNAL, EXTERNAL}`; external parties
authenticate through `party_access_tokens` (single-use, 72h TTL, bound to agreement + party +
IP-family). Employee and MD are always INTERNAL.

**Consequences if decided otherwise:** dropping external mode removes one table and one guard;
dropping internal mode removes the Agent role from RBAC. Either is a small change *if made
before Phase 1b*, and expensive after.

---

### DEC-004 — Is Employee approval a signature or an attested click?
**Severity:** BLOCKER · **Status:** PROPOSED · **Owner:** GTIDS Legal + Management
**Affects:** FR-012, BR-002, BR-003; SDD §4 step 8, §11
**Blocks:** Document Module, workflow module

SDD §11 lists an "Employee approval record" as a distinct stored artifact, but does not say
whether it is (a) an eSign signature on the agreement PDF, (b) a separately generated and
signed approval certificate, or (c) an audit-only event with no document.

Option (a) consumes an eSign transaction per agreement (cost) and requires the Employee to hold
an Aadhaar-linked identity. If the approval is appended to the PDF by re-rendering, it
**invalidates the Agent signature** — see DEC-001.

**Proposed decision (implemented in code):** option (c) + reserved widget. Employee approval is
an authenticated, audited, non-repudiable click recorded in `signature_events` with actor,
timestamp, IP, user-agent and the exact `document_hash` the Employee saw. The reserved
`GTIDS_Employee` widget is filled with a rendered approval attestation via incremental update,
so the agreement PDF visibly carries the approval without an eSign transaction and without
breaking the Agent signature.

---

## B. High — close before the affected phase starts

### DEC-005 — Overlap between `identity_verifications` and `esign_transactions`
**Severity:** HIGH · **Status:** PROPOSED · **Affects:** FR-007; SDD §3, §7
Aadhaar eSign *already performs* Aadhaar OTP authentication as part of the signing ceremony.
FR-007 as written creates a second, independent Aadhaar OTP path, meaning two Aadhaar
integrations, two consent artifacts and two compliance surfaces for one agreement.

**Proposed:** `identity_verifications` is retained but **narrowed** to pre-signature KYC that is
*not* the eSign ceremony — i.e. optional DigiLocker-sourced or offline-Aadhaar-XML verification
performed at data-capture time. The Aadhaar OTP performed during signing is recorded **only**
in `esign_transactions`. FR-007 is reworded accordingly in SRS v1.1. If GTIDS does not require
pre-signature KYC, `identity_verifications` and the whole Identity Module drop out of v1.

### DEC-006 — Public verification endpoint is enumerable
**Severity:** HIGH · **Status:** PROPOSED · **Affects:** FR-019, BR-010; SDD §9
`GET /api/v1/verify/:agreementNumber` keys public access on the agreement number, which is
sequential and guessable. An unauthenticated party can enumerate the entire agreement
population and confirm existence, status and completion dates.

**Proposed:** the QR encodes a 128-bit random `verification_token` (base32, stored on
`agreements`, unique-indexed). The public route becomes `GET /api/v1/verify/:token`. The
response exposes only: agreement number, agreement type name, status, completion date,
document hash. No party names, no emails, no stamp data. Rate limit 10 req/min/IP with
exponential backoff, constant-time response for hit and miss.

### DEC-007 — Rejection and correction semantics (BR-004 undefined)
**Severity:** HIGH · **Status:** PROPOSED · **Affects:** FR-015, BR-004, BR-006; SDD §5
BR-004 says rejection returns the agreement to "a controlled correction/re-initiation state"
without defining it. Open sub-questions: does the agreement return to DRAFT or fork a new
version? Is the allocated stamp released or burned? Can a signed-then-rejected agreement reuse
the Agent's signature?

**Proposed:**
- Rejection at Employee or MD stage → status `REJECTED` (terminal for that version).
- Correction creates **agreement version N+1** on the same `agreements` row: state returns to
  `DRAFT`, `current_version` increments, all prior signatures are void (a corrected document is
  a different document, so prior hashes cannot carry).
- The stamp **stays allocated** to the agreement across correction cycles (it is the same
  transaction), and is only marked `USED` at COMPLETED, or released to `AVAILABLE` on CANCELLED.
  This satisfies BR-006, which forbids reuse across *completed* agreements.
- Rejection reason is mandatory, min 10 chars, stored on the version and in the audit trail.

### DEC-008 — Expiry timeouts and reminder cadence undefined
**Severity:** HIGH · **Status:** PROPOSED · **Affects:** SRS §6 `EXPIRED`; SDD §15
No document states when an agreement expires or how often actors are reminded.
**Proposed defaults (configurable per agreement type):** pending-action SLA 14 calendar days per
stage; reminders at day 3, 7, 12; auto-transition to `EXPIRED` at day 14; expired agreements are
correctable via the DEC-007 versioning path for 30 days, then locked.

### DEC-009 — Stamp allocation concurrency (BR-006)
**Severity:** HIGH · **Status:** PROPOSED · **Affects:** FR-006, BR-006; SDD §7
Application-level checking cannot prevent two concurrent allocations of one stamp.
**Proposed:** `stamp_allocations` carries a **partial unique index** on `stamp_paper_id` where
`released_at IS NULL`, and allocation runs inside a transaction that takes
`SELECT … FOR UPDATE` on the `stamp_papers` row. Database is the arbiter, not the service layer.

### DEC-010 — Provider callback security and idempotency
**Severity:** HIGH · **Status:** PROPOSED · **Affects:** SDD §9 (`POST /esign/callback`), §10
The callback endpoint has no specified authentication, replay protection or idempotency
behaviour. Provider callbacks arrive duplicated, out of order, and after the polling job has
already resolved the same transaction — the classic cause of double state transitions.
**Proposed:** signature verification (provider HMAC over raw body, constant-time compare) +
timestamp window ±5 min + `provider_event_id` unique-indexed in `esign_callback_events` for
idempotent replay + state transitions applied under row lock with a guard that the current state
still matches the expected precondition. Unknown/duplicate events are logged and 200'd.

### DEC-011 — Audit immutability mechanism (SRS §11 "append-oriented")
**Severity:** HIGH · **Status:** PROPOSED · **Affects:** FR-017, BR-009; SDD §3, §7
"Append-oriented" is a property, not a mechanism.
**Proposed, three layers:** (1) the application DB role holds only `INSERT`/`SELECT` on
`audit_logs` — `UPDATE`/`DELETE` are revoked at the database; (2) a `BEFORE UPDATE OR DELETE`
trigger raises unconditionally; (3) each row stores `prev_hash` and `row_hash` forming a
**hash chain** per agreement, so any excision is detectable by a chain-walk. A daily background
job verifies the chain and alerts on breaks.

---

## C. Medium — confirm before UAT

### DEC-012 — Volume and sizing NFRs absent
**Severity:** MEDIUM · **Affects:** SRS §11; SDD §14
No agreements/day, peak concurrency, user population or document size figures exist, so SDD §14
("2+ instances when required") cannot be sized or load-tested against a target.
**Needed from GTIDS:** agreements/day (avg + peak), concurrent signers, retention volume,
average and max document size. **Interim assumption used for load tests:** 200 agreements/day,
25 concurrent users, 20-page / 2 MB documents, 7-year retention.

### DEC-013 — Data retention period not quantified
**Severity:** MEDIUM · **Affects:** SRS §12
SRS §12 defers to "GTIDS policy and applicable legal requirements", which does not yet exist as
a number. Stamp-paper agreements are commonly retained 8 years (Limitation Act exposure).
**Interim assumption:** documents and audit 8 years from completion; identity references purged
at 1 year; email bodies purged at 90 days (metadata retained).

### DEC-014 — MD unavailability / delegation
**Severity:** MEDIUM · **Affects:** FR-013, BR-003, BR-007
A single MD is an unmitigated bottleneck; the docs define no deputy, delegation or
out-of-office path. **Proposed:** an `MD_DELEGATE` role assignable by Super Administrator for a
bounded date range, recorded in the audit trail and printed on the signature attestation. Needs
legal confirmation that a delegate's eSign binds GTIDS.

### DEC-015 — Stamp paper legal model
**Severity:** MEDIUM · **Affects:** FR-005, SRS §7
The design merges a *scan* of a physical ₹100 stamp into a digitally signed PDF. The physical
paper and the digital instrument then exist as two artifacts. **Needs legal confirmation:**
custody rules for the physical original, whether the physical paper must also bear wet
signatures, and per-state validity of the stamp for the counterparty's state.

### DEC-016 — e-Stamp provider for the future integration
**Severity:** MEDIUM · **Affects:** SRS §2, SDD §4 step 3
"Future e-Stamp integration" is required not to disturb the core engine, but no provider
(SHCIL/state portal) is named. **Proposed:** `StampProvider` adapter interface shipped in v1
with only `PhysicalStampProvider` implemented, mirroring the eSign adapter pattern.

### DEC-017 — DigiLocker scope and timeline
**Severity:** MEDIUM · **Affects:** FR-008; SDD §3
DigiLocker requires separate APISetu / Meripehchaan partner registration with its own lead time,
and both documents mark it optional. **Proposed:** explicitly **deferred to v1.1 release**. The
`digilocker_transactions` table and module skeleton ship in v1 unwired.

---

## D. Low — documentation only

| ID | Item | Proposed resolution |
|---|---|---|
| DEC-018 | Agreement numbering scheme unspecified | `GTIDS/{FY}/{TYPE_CODE}/{6-digit zero-padded sequence}`, e.g. `GTIDS/2026-27/EMPAGR/000042`; sequence from a Postgres sequence per FY+type |
| DEC-019 | No specified locale/timezone for displayed timestamps | Store UTC; render Asia/Kolkata; ISO-8601 with offset in all API responses |
| DEC-020 | Email deliverability path not specified (SDD §12) | Dedicated transactional provider with SPF/DKIM/DMARC on the GTIDS domain; bounce webhook feeds `notifications.status` |
| DEC-021 | Browser support floor not versioned (SRS §11) | Last 2 major versions of Chrome/Edge/Safari/Firefox; no IE; documented in README |
| DEC-022 | Accessibility not mentioned anywhere | Target WCAG 2.1 AA for signer-facing screens; the signing flow is used by external parties |
| DEC-023 | No environment matrix (dev/UAT/prod) | Three environments; provider sandbox in dev+UAT, production credentials only in prod |

---

## Phase 0 exit checklist

- [ ] DEC-001 decided **and** Phase 2 spike passing (three valid signatures)
- [ ] DEC-002 decided, provider contracted, sandbox credentials issued
- [ ] DEC-003 decided
- [ ] DEC-004 decided (legal sign-off recorded)
- [ ] DEC-005 … DEC-011 reviewed and accepted or overridden
- [ ] DEC-012, DEC-013 quantified by GTIDS
- [ ] SRS v1.1 and SDD v1.1 amendments issued and approved
- [ ] ERD and OpenAPI spec reviewed against SDD §7–§9

---

## E. Scope change — GTIDS revised workflow (12 Aug 2026)

GTIDS described the workflow they actually want during POC deployment. It differs
from SRS v1.0 in four material respects. Recorded here because the SRS is an
approved document and these are departures from it, not clarifications of it.

### DEC-024 — Two-party execution replaces Agent → Employee → MD
**Severity:** BLOCKER (supersedes SRS §3) · **Status:** DECIDED by GTIDS · **Owner:** GTIDS Management

The mandated sequence becomes **Agent signs → MD signs → COMPLETED**. The Employee
approval step is removed.

**Consequences.** BR-002 no longer exists. BR-003 becomes "MD signing is disabled
until the Agent signature is successful". The agreement carries two signature
widgets rather than three. `EMPLOYEE` ceases to be a required party.

**Raised for GTIDS legal:** the Employee approval was the only point at which
someone inside GTIDS reviewed an Agent-signed agreement before it reached the MD.
Removing it means the MD is the first and only internal reviewer. That may be
correct for the volume involved; it should be a decision rather than a side
effect.

### DEC-025 — Agreements are uploaded, not generated from templates
**Severity:** HIGH · **Status:** DECIDED · **Affects:** FR-002, FR-003, FR-009

GTIDS supplies the agreement as its own document (PDF or Word) per agreement,
rather than the portal generating it from an approved HTML template.

**Consequence.** The FR-003 template-approval controls — versioning, separation of
duties between author and approver, retirement — no longer apply to the text being
executed. Whatever is uploaded is what gets signed. Template management remains in
the product but becomes optional.

**Consequence for evidence.** The portal can no longer reproduce an executed
agreement from template plus data. The uploaded source document is therefore
retained as a document version in its own right, and hashed on upload.

### DEC-026 — Stamp details captured by OCR, confirmed by a person
**Severity:** MEDIUM · **Status:** DECIDED · **Affects:** FR-005, SRS §7

Tesseract reads the uploaded stamp scan and pre-fills the stamp number,
denomination and issue date; an operator confirms or corrects before the record is
created.

**Why confirmation is mandatory.** A misread stamp number becomes the legal
identifier of the instrument, and BR-006 uniqueness is enforced on that value — an
OCR error could let one physical stamp back into circulation. Automatic acceptance
was offered and declined.

### DEC-027 — Composition: stamp scan is page 1
**Severity:** MEDIUM · **Status:** DECIDED · **Affects:** SDD §4 step 4

The executed document is the stamp paper scan as page 1, followed by the agreement
pages. Signature widgets are placed on the final page.

**Still open for GTIDS legal (DEC-015).** Whether an instrument composed this way —
rather than the agreement being physically printed on the stamp paper — satisfies
the stamping requirement in the relevant state. This is the same question already
raised about physical custody, and it now has more weight.

### DEC-028 — Completion notification includes Accounts
**Severity:** LOW · **Status:** DECIDED · **Affects:** FR-018, SDD §12

On completion the signed agreement goes to the Agent, the MD and an Accounts
mailbox. Accounts is a notification-only party: it holds no signing rights and
appears in no signature record.

### DEC-029 — All printed identifiers are recorded, each independently unique
**Severity:** HIGH · **Status:** DECIDED by GTIDS · **Affects:** FR-005, FR-006, BR-006

Reviewing an actual Andhra Pradesh SHCIL e-Stamp supplied by GTIDS showed it
carries three distinct identifiers:

| | |
|---|---|
| Certificate No. | `IN-AP77702625151064Y` |
| Unique Doc. Reference | `SUBIN-APAP1816830336771257804039Y` |
| Paper serial | `FH 0001752181` |

With a single `stamp_number` field, two operators recording the same physical
stamp under different numbers create two AVAILABLE records and BR-006 is defeated
— not by a bug, but by ambiguity over which number is *the* number.

**Decision.** All identifiers are stored in `stamp_identifiers`, each unique
across the whole table. Getting any one right is enough to catch a duplicate.

**Normalisation is part of the decision.** Uniqueness is enforced on an uppercase
alphanumeric form, because `IN-AP777…`, `INAP777…` and `in-ap 777…` are the same
stamp and a raw index accepts all three.

**Excluded on purpose:** the Account Reference. On this certificate it reads
`NEWIMPACC (IV)/ap18168303/AP-VKP/…` — the *vendor's* account, repeated across
every stamp that vendor issues. Treating it as identifying would reject the second
genuine stamp bought from the same vendor. It is stored as an ordinary column.

**Also captured for cross-checking:** issuer, DDO code, document and property
description, consideration price, and the First/Second Party printed on the stamp.
Those party names could later be checked against the agreement's own parties.

### DEC-030 — "Please write or type below this line" (OPEN)
**Severity:** HIGH · **Status:** OPEN · **Owner:** GTIDS Legal · **Affects:** DEC-027, DEC-015

The real stamp paper carries a printed rule across the middle and the instruction
*"Please write or type below this line"*, with roughly 60% of the sheet left blank
beneath it. The convention this document is designed for is that the agreement
text begins **on the stamp paper itself**.

DEC-027 instead places the stamp scan as page 1 with the agreement on following
pages. That may be acceptable, but it is not what the instrument is laid out for,
and it is the same question already raised as DEC-015.

**Needed:** a determination from GTIDS legal, before any agreement is executed for
real. Changing the composition now is inexpensive; changing it after execution is
not.

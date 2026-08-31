# SRS v1.1 — Amendments to SRS v1.0

**System:** GTIDS Online Agreement Management & Digital Signing Portal
**Base document:** Software Requirements Specification v1.0, 09 August 2026
**Amendment version:** 1.1
**Status:** Draft for Review

These are **insertable sections**, not a rewrite. Each entry states the section of SRS v1.0 it
replaces or supplements and the decision (DEC-nnn) it implements. Sections of v1.0 not named
here are unchanged.

---

## Change summary

| # | Section affected | Type | Decision |
|---|---|---|---|
| A1 | §4 Actors, FR-001 | Replace | DEC-003 |
| A2 | FR-007 | Replace | DEC-005 |
| A3 | FR-008 | Replace (defer) | DEC-017 |
| A4 | FR-012 | Replace | DEC-004 |
| A5 | FR-015 | Replace + expand | DEC-007 |
| A6 | FR-019 | Replace | DEC-006 |
| A7 | §5 | New FR-021…FR-027 | DEC-008, DEC-010, DEC-011, DEC-014, DEC-018 |
| A8 | §6 State model | Replace | DEC-007, DEC-008 |
| A9 | §7 Stamp requirements | Supplement | DEC-009, DEC-015, DEC-016 |
| A10 | §8 Digital signing | Supplement | DEC-001, DEC-002 |
| A11 | §11 NFRs | Quantify | DEC-012, DEC-013, DEC-021, DEC-022 |
| A12 | §13 Acceptance criteria | Expand to AC-01…AC-22 | all |

---

## A1 — Replaces §4 (Actors) role definitions for Agent, and FR-001

**FR-001 (revised) — User Authentication and Party Access.**
The system shall authenticate two classes of principal:

- **Internal users** (Employee, MD, Super Administrator, Agreement Administrator, Auditor, and
  Agents where GTIDS provisions them): email + password with mandatory MFA for
  Super Administrator, Agreement Administrator and MD; session tokens with idle timeout of
  30 minutes and absolute timeout of 12 hours.
- **External parties** (Agents not provisioned as internal users): access by a single-use,
  cryptographically signed party access link, valid 72 hours, bound to one agreement and one
  party record, invalidated on use, on agreement state change, or on expiry. External party
  access confers no privilege beyond viewing and acting on that one agreement.

The access class applicable to the Agent is a property of the agreement type
(`party_access_mode ∈ {INTERNAL, EXTERNAL}`), configurable by the Agreement Administrator.

**§4 addition — role: MD Delegate.** A Super Administrator may appoint an MD Delegate for a
bounded date range. The delegate may perform FR-013 only within that range. Appointment,
range and every delegated signature are audit-recorded and named on the signature attestation.
*(DEC-014 — subject to legal confirmation that a delegate's signature binds GTIDS.)*

---

## A2 — Replaces FR-007

**FR-007 (revised) — Pre-signature Identity Verification.**
Where an agreement type requires it, the system shall verify a party's identity **before**
document generation, using the configured third-party provider's Aadhaar-based verification or
a DigiLocker-sourced credential, and shall store only the provider transaction reference, the
verification outcome, the timestamp and the permitted masked identity reference.

**Clarifying note (normative).** The Aadhaar OTP performed *during* the eSign ceremony
(FR-011, FR-013) is part of that signing transaction and is recorded under FR-011/FR-013 in the
signing transaction record. It is **not** a second FR-007 verification and shall not be
duplicated. Where GTIDS does not require pre-signature KYC, FR-007 and the Identity Module are
out of scope for v1. *(DEC-005)*

---

## A3 — Replaces FR-008

**FR-008 (revised) — DigiLocker (deferred).**
DigiLocker retrieval and verification is **deferred to release v1.1**. The v1 system shall ship
the DigiLocker module boundary, configuration surface and `digilocker_transactions` schema
unwired, so that enabling it requires no change to the agreement engine. No v1 acceptance
criterion depends on DigiLocker. *(DEC-017)*

---

## A4 — Replaces FR-012
> ⚠️ **Superseded by DEC-024 (12 Aug 2026).** The Employee approval step was removed;
> the sequence is Agent signs → MD signs. This section is retained as the record of
> what was specified and built beforehand.

**FR-012 (revised) — Employee Approval.**
Employee approval is an **authenticated attested action, not an eSign signature**. The system
shall:
1. Present the Employee the exact document version the Agent signed, and display its SHA-256
   hash.
2. Require explicit affirmation of an attestation statement.
3. Record the approval in the signature-event log with actor identity, UTC timestamp, source IP,
   user-agent, and the `document_hash` of the version displayed.
4. Render the approval attestation into the reserved `GTIDS_Employee` region of the agreement
   PDF **by incremental update only**, so that the Agent's signature remains valid.
5. Reject the approval if the current document hash differs from the hash the Employee was
   shown (stale-view protection).

*(DEC-004, DEC-001)*

---

## A5 — Replaces FR-015 and adds FR-015a/b

**FR-015 (revised) — Rejection.**
Any authorized approver (Employee at PENDING_EMPLOYEE_APPROVAL, MD at PENDING_MD_SIGNATURE) may
reject with a mandatory reason of at least 10 characters. Rejection moves the agreement to
`REJECTED`, which is terminal **for the current agreement version**.

**FR-015a — Correction and re-execution.**
A rejected or expired agreement may be corrected by an authorized user, which shall:
create agreement version N+1 on the same agreement record; return status to `DRAFT`; increment
`current_version`; **void all signatures collected on prior versions** (a corrected document is
a different document and prior hashes cannot carry); retain the stamp allocation; and preserve
every prior version, hash and signature record for audit.

**FR-015b — Stamp disposition on exception.**
The allocated stamp remains `ALLOCATED` to the agreement across correction cycles, transitions
to `USED` only on COMPLETED, and returns to `AVAILABLE` only on CANCELLED. *(DEC-007)*

---

## A6 — Replaces FR-019

**FR-019 (revised) — QR / Public Verification.**
The system shall issue each agreement a 128-bit cryptographically random verification token,
unique across the system, encoded in the QR and in the verification URL. The public
verification endpoint shall be keyed on this token and **not** on the agreement number.

The response shall expose only: agreement number, agreement type name, current status,
completion date (when COMPLETED), and the final document SHA-256. It shall expose no party
name, email, mobile, identity reference or stamp detail.

The endpoint shall be rate limited (10 requests/minute/IP, exponential backoff on repeat
failure) and shall respond in constant time for valid and invalid tokens alike. *(DEC-006,
BR-010)*

---

## A7 — New functional requirements

| ID | Requirement | Description |
|---|---|---|
| FR-021 | Stage SLA & Expiry | Each workflow stage carries an SLA (default 14 calendar days, configurable per agreement type). Reminders are issued at day 3, 7 and 12. On SLA breach the agreement transitions to `EXPIRED`. *(DEC-008)* |
| FR-022 | Reminder Notifications | The system shall notify the actor whose action is pending, on the FR-021 cadence, and shall record each reminder in the notification log. *(DEC-008)* |
| FR-023 | Callback Integrity | Provider callbacks shall be authenticated (provider signature over the raw payload), replay-protected (timestamp window ±5 minutes), and idempotent (unique provider event id). A duplicate or unknown event shall be logged and acknowledged without effect. *(DEC-010)* |
| FR-024 | Transaction Reconciliation | A scheduled job shall reconcile every non-terminal signing transaction against the provider, so that a lost callback cannot strand an agreement. *(SDD §15)* |
| FR-025 | Audit Tamper Evidence | Audit records shall be hash-chained per agreement (each record binds the hash of its predecessor). A scheduled job shall verify chain integrity and raise a security alert on any break. Application database roles shall hold no UPDATE or DELETE privilege on audit tables. *(DEC-011, BR-009)* |
| FR-026 | Agreement Numbering | Agreement numbers shall follow `GTIDS/{financial-year}/{type-code}/{6-digit sequence}` and be allocated atomically without gaps within a financial year and type. *(DEC-018)* |
| FR-027 | Stale-View Protection | Any signing or approval action shall carry the document hash the actor was shown, and shall be rejected if it no longer matches the current version. *(DEC-004)* |

---

## A8 — Replaces §6 (Agreement State Model)

```
                      ┌────────────────── correct (FR-015a) ───────────────┐
                      │                                                    │
                      ▼                                                    │
  [DRAFT] ─► [READY_FOR_AGENT_SIGNATURE] ─► [AGENT_SIGNING] ─► [AGENT_SIGNED]
                      │                            │                       │
                      │                            ▼                       ▼
                      │                    [SIGNATURE_FAILED]   [PENDING_EMPLOYEE_APPROVAL]
                      │                            │                       │
                      │                            └──► retry ──┘          ▼
                      │                                          [EMPLOYEE_APPROVING]
                      │                                                    │
                      │                                                    ▼
                      │                                         [EMPLOYEE_APPROVED]
                      │                                                    │
                      │                                                    ▼
                      │                                      [PENDING_MD_SIGNATURE]
                      │                                                    │
                      │                                                    ▼
                      │                                            [MD_SIGNING]
                      │                                                    │
                      │                                                    ▼
                      └────────────────────────────────────────────► [COMPLETED]  (terminal)

  Exception states reachable as defined below:
    [REJECTED]  ← from PENDING_EMPLOYEE_APPROVAL, EMPLOYEE_APPROVING,
                       PENDING_MD_SIGNATURE, MD_SIGNING          (terminal for version N)
    [CANCELLED] ← from any non-terminal state, by Agreement Administrator (terminal)
    [EXPIRED]   ← from any pending-action state on SLA breach     (terminal for version N)
    [SIGNATURE_FAILED] ← from AGENT_SIGNING, MD_SIGNING; returns to the corresponding
                          READY/PENDING state on retry, max 3 attempts per version
```

**Normative transition rules.**
1. No transition may skip a state. Every transition is validated against this table by the
   Workflow Module and enforced under a row-level lock.
2. `REJECTED` and `EXPIRED` are terminal for agreement version N. Recovery is by FR-015a
   correction, which starts version N+1 at `DRAFT`.
3. `COMPLETED` and `CANCELLED` are absolutely terminal. `COMPLETED` permits no content edit
   (BR-005).
4. Every transition writes exactly one audit record with the prior state, new state, actor and
   trigger.

---

## A9 — Supplements §7 (Stamp Paper Requirements)

**§7.1 Allocation exclusivity (normative).** The uniqueness of a stamp's active allocation shall
be enforced by a database constraint, not by application logic alone: a partial unique index on
the allocation table for un-released allocations, with the stamp row locked for the duration of
the allocating transaction. *(DEC-009, BR-006)*

**§7.2 Additional fields.** `state_code` (ISO 3166-2:IN subdivision) is mandatory, and the
system shall warn when the stamp's issuing state differs from the agreement's place of
execution.

**§7.3 Physical custody (open).** The physical stamp paper remains a legal artifact
independent of the digital instrument. Custody, storage location and whether the physical paper
must additionally bear wet signatures are **pending GTIDS legal determination** (DEC-015) and
shall be recorded here before UAT.

**§7.4 Future e-Stamp.** Stamp sourcing shall sit behind a `StampProvider` interface with
`PhysicalStampProvider` as the only v1 implementation, so that an e-Stamp provider can be added
without change to the agreement engine. *(DEC-016)*

---

## A10 — Supplements §8 (Digital Signing Requirements)

**§8.1 Signature layering (normative).** The agreement PDF shall be generated once per version
with three signature regions reserved at generation time (`GTIDS_Agent`, `GTIDS_Employee`,
`GTIDS_MD`). Each subsequent signature or attestation shall be applied as a **PDF incremental
update**. The system shall never re-render or re-flatten a document that carries a signature.
*(DEC-001)*

**§8.2 Signature model.** The preferred integration is **hash-based**: GTIDS computes the
ByteRange digest, transmits only the digest to the provider, and embeds the returned PKCS#7
signature locally. A document-based provider (provider hosts the ceremony and returns the signed
file) is acceptable only if the provider preserves prior signatures across sequential signing.
*(DEC-002)*

**§8.3 Verification obligation.** After each signature, the system shall verify that (a) the new
signature is cryptographically valid, and (b) **all previously applied signatures remain valid**.
Failure of (b) is a `SIGNATURE_FAILED` condition and shall raise a security alert.

**§8.4 Retained data.** The system shall store: provider name, provider transaction id, provider
event ids, request and response timestamps, the signed ByteRange digest, the signer certificate
subject and serial, and the resulting document hash. It shall never store the Aadhaar number in
clear or the OTP value in any form.

---

## A11 — Replaces §11 (Non-Functional Requirements) rows, quantified

| Category | Requirement (quantified) |
|---|---|
| Volume | Design point: 200 agreements/day average, 600 peak-day; 25 concurrent authenticated users; documents ≤ 20 pages / 2 MB typical, 10 MB hard limit. *(DEC-012 — interim assumption pending GTIDS figures)* |
| Performance | p95 < 2 s for non-generating API calls, excluding provider latency. PDF generation p95 < 15 s, executed asynchronously. Signature application p95 < 3 s excluding provider. Public verification p95 < 500 ms. |
| Availability | 99.9% monthly for GTIDS-controlled components, measured excluding external provider outages. Provider outage shall degrade to queued retry, never to data loss. |
| Retention | Agreement documents and audit records 8 years from completion; identity references purged at 1 year; email message bodies purged at 90 days, delivery metadata retained. *(DEC-013 — interim)* |
| Recovery | RPO ≤ 15 minutes, RTO ≤ 4 hours. Restore tested quarterly against a real restore, not a backup listing. |
| Accessibility | WCAG 2.1 AA for all signer-facing screens. *(DEC-022)* |
| Compatibility | Last two major versions of Chrome, Edge, Safari, Firefox on desktop and mobile. *(DEC-021)* |
| Localization | Timestamps stored UTC, displayed Asia/Kolkata, ISO-8601 with offset in API responses. *(DEC-019)* |

---

## A12 — Replaces §13 (Acceptance Criteria)

v1.0 listed 9 criteria. They are retained and renumbered AC-01…AC-09, with AC-10…AC-22 added.

| ID | Criterion |
|---|---|
| AC-01 | A valid Agent can create an agreement and generate the correct PDF. |
| AC-02 | ~~Agent signature must be completed before Employee approval is enabled.~~ Withdrawn by DEC-024. |
| AC-03 | MD signing must not be possible until the Agent signature is complete. *(Amended by DEC-024.)* |
| AC-04 | MD cannot sign a rejected, expired or cancelled agreement. |
| AC-05 | After MD signature the agreement becomes COMPLETED and content editing is disabled. |
| AC-06 | The final signed document is retrievable from the authorized portal. |
| AC-07 | Completion email is delivered to Agent, Employee and MD. |
| AC-08 | All workflow events appear in the audit trail. |
| AC-09 | The QR/verification reference returns the correct status without exposing sensitive data. |
| AC-10 | **All three signatures validate simultaneously** in an independent PDF reader (Adobe Acrobat Reader), and applying signature N does not invalidate signatures 1…N−1. *(gate for DEC-001)* |
| AC-11 | A stamp already allocated to an active agreement cannot be allocated to a second agreement, proven under concurrent load (≥ 50 simultaneous allocation attempts, exactly one succeeds). |
| AC-12 | A rejected agreement can be corrected into version N+1; prior versions, hashes and signature records remain retrievable and unaltered. |
| AC-13 | A duplicated provider callback produces no second state transition. |
| AC-14 | A dropped provider callback is recovered by the reconciliation job within one job interval. |
| AC-15 | An `UPDATE` or `DELETE` against `audit_logs` by the application database role fails. |
| AC-16 | Breaking the audit hash chain by direct database manipulation is detected by the verification job. |
| AC-17 | The verification endpoint cannot be used to enumerate agreements: sequential token guessing yields no information and is rate-limited. |
| AC-18 | An approval or signature submitted against a stale document hash is rejected. |
| AC-19 | An external party access link is single-use, expires at 72 hours, and grants access to exactly one agreement. |
| AC-20 | An agreement with no action for the configured SLA transitions to EXPIRED and its actors received reminders at day 3, 7 and 12. |
| AC-21 | Aadhaar numbers and OTP values are absent from the database, application logs and error traces (verified by inspection and automated scan). |
| AC-22 | Restore from backup into a clean environment reproduces agreements, documents and audit chains intact, within RTO. |

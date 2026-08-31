# SDD v1.1 — Amendments to SDD v1.0

**System:** GTIDS Online Agreement Management & Digital Signing Portal
**Base document:** Software Design Document v1.0, 09 August 2026
**Amendment version:** 1.1
**Status:** Draft for Review

Insertable sections only. Sections of SDD v1.0 not named here are unchanged.

---

## Change summary

| # | Section affected | Type | Decision |
|---|---|---|---|
| B1 | §2 Technology | Replace PDF row, add rows | DEC-001 |
| B2 | §3 Core Modules | Supplement | DEC-005, DEC-016, DEC-017 |
| B3 | §4 Workflow design | Replace steps 4–13 | DEC-001, DEC-004 |
| B4 | §7 Database Design | 8 new tables | DEC-003, DEC-007, DEC-009, DEC-010, DEC-011 |
| B5 | §8 Key fields | Expand | multiple |
| B6 | §9 API Design | Revise + add | DEC-003, DEC-006, DEC-007 |
| B7 | §10 eSign Adapter | Replace interface | DEC-001, DEC-002 |
| B8 | §11 Document Architecture | Replace | DEC-001 |
| B9 | New §13a Concurrency & Idempotency | New | DEC-009, DEC-010 |
| B10 | New §13b Audit Integrity | New | DEC-011 |
| B11 | §14 Deployment | Quantify | DEC-012 |
| B12 | §17 Testing | Expand | AC-10…AC-22 |

---

## B1 — Replaces §2 PDF Engine row; adds three rows

| Layer | Technology/Design |
|---|---|
| PDF Renderer | Playwright/Chromium — **HTML → flat PDF only**. Produces no signature fields and is never invoked on a document that already carries a signature. |
| PDF Signature Toolkit | `pdf-lib` for AcroForm signature-widget preparation; `@signpdf/*` (or equivalent) for ByteRange computation and PKCS#7 embedding via **incremental update**. |
| PDF Verification | Independent signature-validation step after every signing operation, asserting that all signatures 1…N remain valid. |
| Rate limiting / WAF | Nginx `limit_req` plus application-level token bucket on the public verification and callback routes. |

**Rationale.** SDD v1.0 named a single "PDF engine", but generation and signing are different
problems with different libraries. Conflating them is what produces the
signature-invalidation failure mode described in DEC-001.

---

## B2 — Supplements §3 (Core Modules)

| Module | Amended responsibility |
|---|---|
| Identity Module | Scope narrowed to **pre-signature** KYC only. Aadhaar OTP occurring inside the eSign ceremony belongs to the eSign Module. If GTIDS requires no pre-signature KYC, this module is not built in v1. *(DEC-005)* |
| DigiLocker Module | Boundary and schema only in v1; unwired. Enabled in v1.1. *(DEC-017)* |
| Stamp Management | Fronted by a `StampProvider` interface; `PhysicalStampProvider` is the only v1 implementation. e-Stamp arrives as a second implementation with no change to the agreement engine. *(DEC-016)* |
| Document Module | Split internally into **Renderer** (HTML→PDF), **Preparer** (signature-widget placement), **Signer** (incremental-update application), **Verifier** (multi-signature validation), **Store** (object storage + hash). |
| Workflow Module | Owns the transition table exclusively. No other module may write `agreements.status`. All transitions execute under `SELECT … FOR UPDATE` on the agreement row. |
| Audit Module | Hash-chained, insert-only, with a chain-verification job. *(DEC-011)* |

---

## B3 — Replaces §4 steps 4–13

| Step | Design (amended) |
|---|---|
| 4. Generation | Renderer produces flat PDF from template + data + stamp scan. Preparer adds three reserved signature widgets (`GTIDS_Agent`, `GTIDS_Employee`, `GTIDS_MD`). The result is stored as version N and hashed. **This is the last time the document is rendered.** |
| 5. Agent Review | Agent is shown the document and its SHA-256. The hash is echoed back with the signing request (FR-027). |
| 6. Agent Sign | eSign Module computes the ByteRange digest over the prepared PDF, creates a provider transaction, and the provider performs the Aadhaar OTP ceremony. |
| 7. Agent Completion | Returned PKCS#7 is embedded into the `GTIDS_Agent` widget by incremental update. Verifier asserts signature 1 valid. New byte stream stored as a new document row with its own hash; the pre-signature version is retained. State → `AGENT_SIGNED` → `PENDING_EMPLOYEE_APPROVAL`. |
| 8. Employee Approval | Employee is shown the Agent-signed document and its hash. On affirmation, the attestation is rendered into `GTIDS_Employee` **by incremental update**. Verifier asserts signature 1 still valid. No eSign transaction is consumed. *(DEC-004)* |
| 9. MD Queue | State → `PENDING_MD_SIGNATURE`; MD (or MD Delegate, DEC-014) notified. |
| 10. MD Sign | As step 6, over the current byte stream, into `GTIDS_MD`. |
| 11. Finalization | Verifier asserts **all** signatures valid. Final document stored, `completed_at` set, state → `COMPLETED`, stamp → `USED`, verification token minted. All under one transaction; document write precedes state commit. |
| 12. Notification | Completion notification enqueued for Agent, Employee, MD — enqueued only after the finalization transaction commits (BR-008). |
| 13. Verification | Public record published keyed on the random verification token, not the agreement number. *(DEC-006)* |

---

## B4 — Supplements §7 (Database Design) — eight new tables

| Table | Purpose | Decision |
|---|---|---|
| `party_access_tokens` | Single-use, expiring access grants for external parties: token hash, agreement, party, expiry, used_at, issued_ip | DEC-003 |
| `agreement_version_history` | Per-version lifecycle: version_no, status, rejection reason, superseded_by, voided signatures | DEC-007 |
| `esign_callback_events` | Raw provider events with `provider_event_id` unique — idempotency ledger | DEC-010 |
| `workflow_transitions` | Every state change: from_state, to_state, actor, trigger, agreement_version | A8 rule 4 |
| `notification_recipients` | Per-recipient delivery state for a notification (SDD §12 requires three recipient records per completion) | SDD §12 |
| `stage_slas` | Per-agreement-type stage SLA and reminder schedule | DEC-008 |
| `md_delegations` | Delegate, valid_from, valid_to, appointed_by | DEC-014 |
| `audit_chain_heads` | Current chain head hash per agreement, for O(1) append and chain verification | DEC-011 |

**Amendments to existing tables**

- `agreements`: add `verification_token` (unique), `current_status_version`, `place_of_execution_state`, `expires_at`, `party_access_mode`.
- `stamp_allocations`: add `released_at`; **partial unique index** `(stamp_paper_id) WHERE released_at IS NULL`. *(DEC-009)*
- `audit_logs`: add `prev_hash`, `row_hash`, `agreement_version`. Revoke `UPDATE`/`DELETE` from the application role; add a rejecting trigger. *(DEC-011)*
- `esign_transactions`: add `byte_range_digest`, `signer_cert_subject`, `signer_cert_serial`, `attempt_no`, `failure_code`.
- `agreement_versions`: add `signature_state` (`UNSIGNED`/`AGENT_SIGNED`/`EMPLOYEE_ATTESTED`/`FINAL`), `supersedes_id`.
- `users`: add `user_type ∈ {INTERNAL, EXTERNAL}`, `mfa_enrolled_at`.

---

## B5 — Supplements §8 (Key Database Fields)

| Table | Added important fields |
|---|---|
| `agreements` | `verification_token`, `expires_at`, `party_access_mode`, `place_of_execution_state`, `rejected_reason`, `rejected_by`, `rejected_at` |
| `esign_transactions` | `byte_range_digest`, `attempt_no`, `failure_code`, `signer_cert_subject`, `signer_cert_serial` |
| `audit_logs` | `prev_hash`, `row_hash`, `agreement_version` |
| `stamp_allocations` | `allocated_at`, `released_at`, `released_reason` |
| `party_access_tokens` | `token_hash` (never the token), `expires_at`, `used_at`, `issued_to_party_id` |
| `esign_callback_events` | `provider_event_id` (unique), `raw_payload`, `signature_valid`, `processed_at`, `outcome` |

---

## B6 — Amends §9 (API Design)

**Revised**

| Endpoint | Change |
|---|---|
| `GET /api/v1/verify/:agreementNumber` | **Replaced by** `GET /api/v1/verify/:token` — random token, rate-limited, constant-time. *(DEC-006)* |
| `POST /api/v1/esign/callback` | Now requires provider signature header, timestamp window and `provider_event_id`; idempotent. *(DEC-010)* |
| ~~`POST /api/v1/agreements/:id/employee-approve`~~ | Removed by DEC-024. Stale-view protection (FR-027) now applies to `sign/agent` and `sign/md`. |

**Added**

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/agreements/:id/correct` | Create version N+1 from a rejected/expired agreement *(DEC-007)* |
| `POST /api/v1/agreements/:id/cancel` | Administrative cancellation with reason |
| `POST /api/v1/agreements/:id/party-access` | Issue a single-use external party link *(DEC-003)* |
| `POST /api/v1/party-access/redeem` | Redeem a party access token for a scoped session |
| `GET /api/v1/agreements/:id/versions` | List document versions with hashes and signature state |
| `POST /api/v1/stamps/:id/release` | Release an allocation on cancellation |
| `GET /api/v1/agreements/:id/verify-signatures` | On-demand re-validation of all signatures on the current document |
| `GET /api/v1/audit/verify-chain` | Audit chain integrity check *(DEC-011)* |
| `GET /api/v1/health`, `GET /api/v1/health/ready` | Liveness and readiness for the load balancer |

---

## B7 — Replaces §10 (eSign Provider Adapter)

The v1.0 interface assumes a document-based provider. The amended interface supports the
hash-based model (the CCA eSign 2.1 norm) and keeps the document-based model as an optional
capability flag.

| Member | Purpose |
|---|---|
| `capabilities()` | Declares `{ mode: 'HASH' \| 'DOCUMENT', supportsSequentialSignatures: boolean, returnsSignedDocument: boolean }` |
| `initiateSigning(req)` | Creates a signing request from `{ signer, byteRangeDigest \| document, agreementRef, callbackUrl }`; returns `{ providerTransactionId, ceremonyUrl }` |
| `getStatus(providerTransactionId)` | Polls transaction status (used by the reconciliation job) |
| `verifyCallback(rawBody, headers)` | **New.** Validates provider signature, timestamp window and event id before any parsing |
| `handleCallback(event)` | Maps a verified provider event to a domain event; must be idempotent |
| `getSignature(providerTransactionId)` | **New.** Retrieves the PKCS#7 blob for embedding (HASH mode) |
| `getSignedDocument(providerTransactionId)` | Retrieves the signed file (DOCUMENT mode only) |
| `validateTransaction(providerTransactionId)` | Confirms transaction integrity/status against the provider |

**Constraint (normative).** No module outside `src/esign/providers/` may reference a provider
name, a provider-specific field, or a provider error code. The workflow module consumes only
domain events. *(SDD §20)*

---

## B8 — Replaces §11 (Document Architecture)

Object layout, private bucket, versioned:

```
agreements/{year}/{month}/{agreement-number}/
  v{n}/
    stamp-original.pdf            # uploaded scan, hashed on upload
    generated-unsigned.pdf        # renderer output, flat
    prepared-unsigned.pdf         # + three reserved signature widgets  ← signing baseline
    agent-signed.pdf              # prepared + incremental update 1
    employee-attested.pdf         # + incremental update 2
    final-md-signed.pdf           # + incremental update 3   ← immutable, COMPLETED
    audit-certificate.pdf         # generated on completion
```

**Normative rules.**
1. Every object above is written once and never modified. A new state produces a new object.
2. Every object has a SHA-256 recorded in `agreement_documents` at write time.
3. `prepared-unsigned.pdf` is the signing baseline: every signature's ByteRange is computed
   against the accumulated byte stream starting from it.
4. No object is served directly. Access is via short-lived (≤ 5 min) pre-signed URLs issued only
   after an authorization check, and every issuance is audited.
5. Buckets deny public access at the policy level; correctness does not depend on URL secrecy.

---

## B9 — New §13a: Concurrency & Idempotency

**Agreement state transitions.** Every transition executes as:
`BEGIN; SELECT … FROM agreements WHERE id = $1 FOR UPDATE; assert current_state = expected;
apply; INSERT workflow_transitions; INSERT audit_logs; COMMIT;`
An optimistic-concurrency `version` column additionally guards API-level lost updates.

**Stamp allocation (DEC-009).** Partial unique index is the arbiter:
```sql
CREATE UNIQUE INDEX uq_stamp_active_allocation
  ON stamp_allocations (stamp_paper_id) WHERE released_at IS NULL;
```
The service takes `FOR UPDATE` on `stamp_papers`, inserts the allocation, and translates a
unique-violation into a domain conflict error. Correctness holds under any level of concurrency
and across multiple API instances.

**Provider callbacks (DEC-010).** `esign_callback_events.provider_event_id` is unique. Processing
is: verify signature → insert event (unique violation ⇒ already processed, return 200) →
apply transition under row lock with precondition check → mark processed.

**Outbox for notifications.** Completion emails are written to an outbox row inside the
finalization transaction and dispatched by a worker after commit, so no email can be sent for an
agreement that failed to finalize (BR-008), and no completion can silently skip its email.

---

## B10 — New §13b: Audit Integrity

Three independent layers, so that defeating one does not defeat the property:

1. **Privilege.** The application database role is granted `INSERT, SELECT` on `audit_logs` only.
   `UPDATE` and `DELETE` are not granted to any role used by the application.
2. **Trigger.** `BEFORE UPDATE OR DELETE ON audit_logs` raises an exception unconditionally.
3. **Hash chain.** Each row stores
   `row_hash = SHA256(prev_hash ‖ agreement_id ‖ actor_id ‖ event_type ‖ canonical_json(event_data) ‖ timestamp)`
   with `prev_hash` the predecessor's `row_hash` for that agreement (genesis = 64 zeros).
   `audit_chain_heads` holds the current head for O(1) append. A daily job walks every chain and
   raises a security alert on mismatch, which detects excision even by an actor holding
   database-level privileges.

---

## B11 — Amends §14 (Deployment Architecture)

Sized to the DEC-012 interim design point (200 agreements/day avg, 600 peak, 25 concurrent):

| Component | Sizing |
|---|---|
| API | 2 instances × 2 vCPU / 4 GB behind the load balancer |
| Worker | 2 instances × 2 vCPU / 4 GB — Chromium rendering is memory-hungry; workers are sized separately from API and never co-located |
| PostgreSQL | 4 vCPU / 16 GB, PITR enabled, RPO ≤ 15 min |
| Redis | 2 GB, AOF persistence on (BullMQ job durability depends on it) |
| Object storage | Versioning on, lifecycle to cold storage at 1 year, retention lock to 8 years *(DEC-013)* |
| Environments | dev, UAT, production. Provider **sandbox** credentials in dev and UAT; production credentials exist only in production secret storage *(DEC-023)* |

---

## B12 — Supplements §17 (Testing Strategy)

Added, mapped to the amended acceptance criteria:

| Test | Covers |
|---|---|
| Multi-signature integrity suite — apply 3 signatures, assert all valid, assert prior validity after each step, validate output in an independent reader | AC-10 |
| Concurrent stamp allocation — 50 parallel attempts on one stamp, assert exactly one success | AC-11 |
| Correction cycle — reject → correct → re-sign; assert prior versions immutable and retrievable | AC-12 |
| Callback idempotency & replay — duplicate, out-of-order and forged callbacks | AC-13 |
| Reconciliation — drop the callback, assert the job recovers the transaction | AC-14 |
| Audit privilege & tamper detection — attempt UPDATE/DELETE as the app role; corrupt a row out-of-band and assert the chain job detects it | AC-15, AC-16 |
| Verification enumeration — sequential token probing, rate-limit behaviour, response-time equality for hit vs miss | AC-17 |
| Stale-hash rejection | AC-18 |
| Party access token — single-use, expiry, cross-agreement access attempt | AC-19 |
| SLA/expiry — clock-advanced run asserting reminders and EXPIRED transition | AC-20 |
| Sensitive-data scan — automated grep of database, logs and traces for Aadhaar/OTP patterns | AC-21 |
| Restore drill — restore to a clean environment, verify documents and audit chains | AC-22 |

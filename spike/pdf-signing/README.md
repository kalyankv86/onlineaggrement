# Phase 2 Gate — Multi-signature PDF integrity

**Decision:** DEC-001 · **Acceptance criterion:** AC-10 · **Status: PASSED**

```bash
cd spike/pdf-signing && npm install && node run.js
```

## What this proves

SRS §8 forbids modifying a signed PDF in a way that invalidates an earlier signature, while
the workflow applies three actions to one document. This spike establishes that the constraint
is satisfiable, and *how*.

| Step | Mechanism | Result |
|---|---|---|
| Render | Playwright/Chromium (stubbed here) → flat PDF | no signature fields |
| Prepare | `pdf-lib` adds 3 AcroForm signature widgets **before any signature** | signing baseline |
| Agent sign | incremental update #1 — append sig object + updated field + new xref with `/Prev` | sig 1 valid |
| Employee approve | incremental update #2 — appearance stream only, **no eSign transaction** | sig 1 still valid |
| MD sign | incremental update #3 | sigs 1 and 2 both valid |

## Measured result

```
signature 1  covers 20,150 bytes (prefix; later revisions appended)   VALID
signature 2  covers 37,929 bytes (whole file)                         VALID
tampered document                                                     REJECTED
poppler pdfsig                                     2 × "Signature is Valid."
```

`pdfsig` reports the Agent signature as "Not total document signed" — this is correct and
expected. A signature made in revision *k* covers a prefix of the file; the later revisions were
appended after it. Adobe Acrobat renders this as "signed and all signatures are valid, with
subsequent changes permitted by the signature".

## Design consequences carried into the API

These are load-bearing and are why `src/documents/pdf/` is built the way it is:

1. **The renderer runs exactly once per agreement version.** Chromium and `pdf-lib.save()`
   both rewrite the entire file and would destroy every prior signature. After
   `prepared-unsigned.pdf` exists, only `signer.ts` may touch the bytes.
2. **All three widgets are reserved up front.** A signature field cannot be added later
   without an incremental update of its own, and reserving them keeps field geometry stable.
3. **Signing is append-only.** `appendRevision()` never mutates existing bytes — the spike
   asserts byte-for-byte equality of the prefix after every step.
4. **The `/ByteRange` array is patched before digesting**, since those bytes are themselves
   inside the signed range. Fixed-width zero-padded integers keep the patch length-neutral.
5. **8 KB is reserved per signature.** Observed RSA-2048 detached CMS with one certificate:
   1,367 bytes. A real ESP response carrying a full chain and an RFC-3161 timestamp is larger;
   8 KB leaves generous headroom and the signer errors loudly rather than truncating.
6. **Verification runs after every signing step**, not only at the end (SRS v1.1 §8.3).

## Files

| File | Role |
|---|---|
| `src/pdf-objects.js` | minimal xref/trailer/object parser (classic xref tables only) |
| `src/incremental.js` | `appendRevision`, `appendSignature`, `appendAttestation` |
| `src/pkcs7.js` | detached CMS via node-forge — stands in for the ESP |
| `src/prepare.js` | flat render + signature-widget reservation |
| `src/verify.js` | structural + digest verification of every signature |
| `run.js` | the gate itself, 8 steps including a tamper negative-control |

## Remaining manual step for AC-10 sign-off

Open `out/5-final-md-signed.pdf` in **Adobe Acrobat Reader** and confirm the signature panel
shows both signatures as valid. Certificate trust will report as unknown because the spike uses
a self-signed certificate; with a real CCA-licensed ESP certificate the chain resolves.

## What this spike does *not* cover

- Cross-reference **streams** (`/Type /XRef`). The generator is ours and emits classic tables;
  a third-party PDF uploaded as a template would need handling.
- **DocMDP** / certification signatures and permitted-change levels.
- **PAdES LTV** (embedded OCSP/CRL + document timestamp). Required if agreements must remain
  verifiable after certificate expiry — raise with GTIDS legal as part of DEC-013 retention.

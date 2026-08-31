'use client';

import { useActionState, useState } from 'react';
import { readStampScan, registerStamp, type ActionResult, type StampReading } from '@/app/actions';
import { Notice, Field } from './ui';

const initial: ActionResult = {};

/**
 * DEC-026 — scan, read, confirm, save.
 *
 * OCR proposes; a person decides. A misread stamp number becomes the legal
 * identifier of the instrument and is the value BR-006 uniqueness is enforced on,
 * so nothing is written until someone has looked at it. Fields the reader was
 * unsure about are marked rather than presented as equally trustworthy.
 */
export function StampScanForm() {
  const [readState, readAction, reading] = useActionState(readStampScan, initial);
  const [saveState, saveAction, saving] = useActionState(registerStamp, initial);
  const [scanName, setScanName] = useState('');

  const proposal: StampReading | undefined = readState.reading;
  const lowConfidence = (field: string) => proposal?.confidence?.[field] === 'low';

  /** What OCR read for a given identifier kind, if anything. */
  const identifier = (kind: string) =>
    proposal?.identifiers?.find((i) => i.kind === kind)?.value ?? '';

  return (
    <div className="card">
      <h2>Register a stamp paper</h2>

      {readState.error && <Notice tone="error">{readState.error}</Notice>}
      {saveState.error && (
        <Notice tone="error" title={saveState.rule ? `Refused — ${saveState.rule}` : 'Refused'}>
          {saveState.error}
        </Notice>
      )}
      {saveState.ok && (
        <Notice tone="success">
          Registered. The scan was hashed on upload, so any later alteration is detectable.
        </Notice>
      )}

      {/* Step 1 — read the scan. */}
      <form action={readAction}>
        <div className="field">
          <label htmlFor="scan">Scan of the stamp paper</label>
          <input
            id="scan"
            name="scan"
            type="file"
            required
            accept="application/pdf,image/png,image/jpeg"
            onChange={(e) => setScanName(e.target.files?.[0]?.name ?? '')}
          />
          <div className="hint">
            PDF, PNG or JPEG, up to 10 MB. 300 dpi or better gives the certificate number the best
            chance of being read correctly.
          </div>
        </div>
        <button type="submit" className="btn-secondary" disabled={reading}>
          {reading ? 'Reading…' : 'Read the scan'}
        </button>
        {scanName && <span className="faint" style={{ marginLeft: 12 }}>{scanName}</span>}
      </form>

      {/* Step 2 — confirm what it read, then save. */}
      {proposal && (
        <form action={saveAction} style={{ marginTop: 22 }}>
          <input type="hidden" name="scanBase64" value={readState.scanBase64 ?? ''} />
          <input type="hidden" name="scanContentType" value={readState.scanContentType ?? ''} />

          <Notice tone="warn" title="Check these against the physical paper before saving">
            These values were read by OCR. Every identifier below is stored and each one
            independently blocks the same stamp being registered twice — so it is worth entering
            all of those the paper carries, and worth getting each one exactly right.
          </Notice>

          {proposal.warnings?.length > 0 && (
            <ul className="faint" style={{ paddingLeft: 18, marginTop: -6 }}>
              {proposal.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px', margin: '0 0 18px' }}>
            <legend className="faint" style={{ padding: '0 6px' }}>
              Identifiers — each one is checked for duplicates
            </legend>

            <Field
              label={`Certificate number${lowConfidence('stampNumber') ? '  — uncertain' : ''}`}
              name="certificateNo"
              defaultValue={identifier('CERTIFICATE_NO') || proposal.stampNumber || ''}
              style={lowConfidence('stampNumber') ? { borderColor: 'var(--waiting)' } : undefined}
              hint="e.g. IN-AP77702625151064Y. Watch for O/0 and I/1."
            />
            <Field
              label="Unique document reference"
              name="uniqueDocRef"
              defaultValue={identifier('UNIQUE_DOC_REF')}
              hint="e.g. SUBIN-… — this is what the issuer's portal verifies against."
            />
            <Field
              label="Pre-printed paper serial"
              name="paperSerial"
              defaultValue={identifier('PAPER_SERIAL')}
              hint="Usually bottom-right, e.g. FH 0001752181."
            />
            <p className="faint" style={{ margin: '4px 0 0' }}>
              Punctuation, spacing and case are ignored when checking for duplicates, so
              IN-AP777… and inap777… count as the same stamp.
            </p>
          </fieldset>

          <div className="grid grid-2">
            <Field
              label="Denomination (Rs.)"
              name="denomination"
              type="number"
              defaultValue={proposal.denomination ?? 100}
              required
            />
            <Field
              label="Issuing state"
              name="stateCode"
              defaultValue={proposal.stateCode ?? ''}
              required
              hint="ISO 3166-2:IN"
            />
          </div>
          <div className="grid grid-2">
            <Field label="Issue date" name="issueDate" type="date" defaultValue={proposal.issueDate ?? ''} />
            <Field label="Vendor" name="vendor" defaultValue={proposal.vendor ?? ''} />
          </div>

          <details style={{ margin: '4px 0 18px' }}>
            <summary className="faint" style={{ cursor: 'pointer' }}>
              Other details printed on the stamp
            </summary>
            <div style={{ marginTop: 12 }}>
              <div className="grid grid-2">
                <Field label="Issuer" name="issuer" defaultValue={proposal.issuer ?? ''} />
                <Field
                  label="Consideration price (Rs.)"
                  name="considerationPrice"
                  type="number"
                  defaultValue={proposal.considerationPrice ?? ''}
                  hint="Not the duty — this is often zero."
                />
              </div>
              <div className="grid grid-2">
                <Field
                  label="Description of document"
                  name="documentDescription"
                  defaultValue={proposal.documentDescription ?? ''}
                />
                <Field
                  label="Property description"
                  name="propertyDescription"
                  defaultValue={proposal.propertyDescription ?? ''}
                />
              </div>
              <div className="grid grid-2">
                <Field label="First party" name="firstParty" defaultValue={proposal.firstParty ?? ''} />
                <Field label="Second party" name="secondParty" defaultValue={proposal.secondParty ?? ''} />
              </div>
              <div className="grid grid-2">
                <Field
                  label="Account reference"
                  name="accountReference"
                  defaultValue={proposal.accountReference ?? ''}
                  hint="Identifies the vendor account, not this stamp — not used for duplicate checks."
                />
                <Field label="DDO code" name="ddoCode" defaultValue={proposal.ddoCode ?? ''} />
              </div>
            </div>
          </details>

          <div className="row">
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Confirm and register'}
            </button>
            <details>
              <summary className="faint" style={{ cursor: 'pointer' }}>
                Show the raw text that was read
              </summary>
              <pre
                className="mono"
                style={{
                  whiteSpace: 'pre-wrap',
                  background: 'var(--surface-2)',
                  padding: 12,
                  borderRadius: 6,
                  marginTop: 8,
                  maxHeight: 220,
                  overflow: 'auto',
                }}
              >
                {proposal.rawText}
              </pre>
            </details>
          </div>
        </form>
      )}

      <p className="faint" style={{ marginBottom: 0, marginTop: 14 }}>
        The physical paper remains a legal artifact in its own right. GTIDS custody rules for the
        original are pending legal determination.
      </p>
    </div>
  );
}

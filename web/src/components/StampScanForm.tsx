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

          <Notice tone="warn" title="Check these before saving">
            These values were read from the scan by OCR. Compare them against the physical stamp
            paper — the stamp number is what prevents the same stamp being used twice.
          </Notice>

          {proposal.warnings?.length > 0 && (
            <ul className="faint" style={{ paddingLeft: 18, marginTop: -6 }}>
              {proposal.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <Field
            label={`Stamp / certificate number${lowConfidence('stampNumber') ? '  — uncertain' : ''}`}
            name="stampNumber"
            defaultValue={proposal.stampNumber ?? ''}
            required
            style={lowConfidence('stampNumber') ? { borderColor: 'var(--waiting)' } : undefined}
            hint="Must match the physical paper exactly. Watch for O/0 and I/1."
          />

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

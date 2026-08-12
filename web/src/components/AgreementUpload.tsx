'use client';

import { useActionState, useState } from 'react';
import { uploadAgreementDocument, type ActionResult } from '@/app/actions';
import { Notice } from './ui';

const initial: ActionResult = {};

/**
 * DEC-025 — GTIDS supplies the agreement; the portal composes it with the stamp
 * scan rather than generating it from a template.
 *
 * The stamp must already be allocated, because it becomes page 1 of the executed
 * document (DEC-027) — so the API refuses this until it is, and the UI says why
 * rather than letting someone upload into a dead end.
 */
export function AgreementUpload({
  agreementId,
  hasStamp,
}: {
  agreementId: string;
  hasStamp: boolean;
}) {
  const [state, action, pending] = useActionState(uploadAgreementDocument, initial);
  const [filename, setFilename] = useState('');

  return (
    <div className="card">
      <h2>Attach the agreement</h2>

      {state.error && (
        <Notice tone="error" title={state.rule ? `Refused — ${state.rule}` : 'Could not attach'}>
          {state.error}
        </Notice>
      )}

      {!hasStamp && (
        <Notice tone="warn" title="Allocate the stamp paper first">
          The stamp scan becomes page 1 of the executed document, so it has to be attached before
          the agreement.
        </Notice>
      )}

      <form action={action}>
        <input type="hidden" name="agreementId" value={agreementId} />

        <div className="field">
          <label htmlFor="document">Your agreement document</label>
          <input
            id="document"
            name="document"
            type="file"
            required
            disabled={!hasStamp}
            accept=".pdf,.doc,.docx,.odt,.rtf,application/pdf"
            onChange={(e) => setFilename(e.target.files?.[0]?.name ?? '')}
          />
          <div className="hint">
            PDF or Word, up to 12 MB. Word documents are converted to PDF on the server — check
            the result before signing, since conversion is not always layout-perfect.
          </div>
        </div>

        <button type="submit" disabled={pending || !hasStamp}>
          {pending ? 'Composing…' : 'Attach and compose'}
        </button>

        {filename && (
          <span className="faint" style={{ marginLeft: 12 }}>
            {filename}
          </span>
        )}
      </form>

      <p className="faint" style={{ marginTop: 14, marginBottom: 0 }}>
        The file is stored exactly as supplied and hashed on upload. It is the only record of what
        GTIDS intended to execute, so it is kept alongside the composed document rather than
        discarded after composition.
      </p>
    </div>
  );
}

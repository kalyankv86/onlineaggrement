'use client';

import { useActionState, useState } from 'react';
import { createAgreement, type ActionResult } from '@/app/actions';
import { Notice, Field } from './ui';

const initial: ActionResult = {};

interface Option {
  type: {
    id: string;
    code: string;
    name: string;
    requires_stamp: boolean;
    document_source: 'UPLOAD' | 'TEMPLATE';
  };
  templates: { id: string; name: string; versions: { id: string; version_no: number }[] }[];
}

/**
 * Particulars. For a TEMPLATE type these are merged into the generated document
 * and are required. For an UPLOAD type the agreement text comes from the file
 * GTIDS supplies, so these are record-keeping only — they make the register
 * searchable and drive reporting, and are deliberately optional.
 */
const PARTICULARS = [
  { name: 'executionDate', label: 'Date of execution', type: 'date' },
  { name: 'placeOfExecution', label: 'Place of execution', placeholder: 'Bhubaneswar, Odisha' },
  { name: 'agentName', label: 'Counterparty name' },
  { name: 'serviceDescription', label: 'Subject of the agreement' },
  { name: 'termMonths', label: 'Term (months)', type: 'number' },
  { name: 'startDate', label: 'Commencement date', type: 'date' },
  { name: 'consideration', label: 'Consideration', placeholder: 'Rs. 4,50,000' },
];

// DEC-024 — two signing parties. Accounts is attached automatically from the
// agreement type and is not entered here, because it signs nothing.
const PARTIES = [
  { key: 'AGENT', label: 'Agent', note: 'Signs first, with an Aadhaar OTP.' },
  { key: 'MD', label: 'Managing Director', note: 'Signs last; completion follows this signature.' },
] as const;

export function NewAgreementForm({ options }: { options: Option[] }) {
  const [state, action, pending] = useActionState(createAgreement, initial);
  const [typeId, setTypeId] = useState(options[0]?.type.id ?? '');

  const selected = options.find((o) => o.type.id === typeId);
  const templates = selected?.templates ?? [];
  const needsTemplate = selected?.type.document_source === 'TEMPLATE';

  if (options.length === 0) {
    return (
      <Notice tone="warn" title="No usable agreement types">
        An administrator needs to configure an agreement type first. Template-based types also
        need an approved template version.
      </Notice>
    );
  }

  return (
    <form action={action}>
      {state.error && (
        <Notice tone="error" title={state.rule ? `Refused — ${state.rule}` : 'Could not create'}>
          {state.error}
        </Notice>
      )}

      <div className="card">
        <h2>Agreement type</h2>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="agreementTypeId">Type</label>
            <select
              id="agreementTypeId"
              name="agreementTypeId"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              required
            >
              {options.map((o) => (
                <option key={o.type.id} value={o.type.id}>
                  {o.type.name} ({o.type.code})
                </option>
              ))}
            </select>
          </div>

          {needsTemplate ? (
            <div className="field">
              <label htmlFor="templateVersionId">Template</label>
              <select id="templateVersionId" name="templateVersionId" required>
                {templates.flatMap((t) =>
                  t.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {t.name} — v{v.version_no}
                    </option>
                  )),
                )}
              </select>
              <div className="hint">Only approved template versions can be executed.</div>
            </div>
          ) : (
            <div className="field">
              <label>Agreement document</label>
              <div className="hint" style={{ marginTop: 0 }}>
                This type uses your own document. You will attach it on the next screen, once the
                stamp paper is allocated — the stamp scan becomes page 1 of what gets signed.
              </div>
            </div>
          )}
        </div>

        <Field
          label="State of execution"
          name="placeOfExecutionState"
          placeholder="IN-OR"
          hint="ISO 3166-2 subdivision. Should match the state that issued the stamp paper."
        />
      </div>

      <div className="card">
        <h2>Agreement particulars</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          {needsTemplate
            ? 'These are merged into the generated agreement.'
            : 'For the register and reporting only — they are not printed into your document.'}
        </p>
        <div className="grid grid-2">
          {PARTICULARS.map((p) => (
            <Field
              key={p.name}
              label={p.label}
              name={`var.${p.name}`}
              type={p.type ?? 'text'}
              placeholder={p.placeholder}
              required={needsTemplate}
            />
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Parties</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          Both are required, and they act strictly in this order — the MD cannot sign an agreement
          the Agent has not executed.
        </p>
        {/*
          Labels name the party explicitly. Two fields both labelled "Full name"
          on one page are ambiguous to a screen reader, and equally ambiguous to
          anything else addressing the form by label.
        */}
        {PARTIES.map((party) => (
          <div key={party.key} style={{ marginBottom: 18 }}>
            <h3>
              {party.label} <span style={{ textTransform: 'none', fontWeight: 400 }}>— {party.note}</span>
            </h3>
            <div className="grid grid-3">
              <Field
                label={`${party.label} full name`}
                name={`${party.key}.name`}
                required
                minLength={2}
              />
              <Field label={`${party.label} email`} name={`${party.key}.email`} type="email" required />
              <Field label={`${party.label} mobile (optional)`} name={`${party.key}.mobile`} />
            </div>
          </div>
        ))}
      </div>

      <div className="row">
        <button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create draft agreement'}
        </button>
        <span className="faint">You can edit the particulars while it remains a draft.</span>
      </div>
    </form>
  );
}

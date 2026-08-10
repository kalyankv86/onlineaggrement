'use client';

import { useActionState, useState } from 'react';
import { createAgreement, type ActionResult } from '@/app/actions';
import { Notice, Field } from './ui';

const initial: ActionResult = {};

interface Option {
  type: { id: string; code: string; name: string; requires_stamp: boolean };
  templates: { id: string; name: string; versions: { id: string; version_no: number }[] }[];
}

/**
 * The particulars a Service Engagement Agreement needs. These mirror the seeded
 * template's declared variables — an undeclared placeholder would render as
 * literal `{{name}}` in an executed legal document, which the API rejects at
 * template-authoring time rather than here.
 */
const PARTICULARS = [
  { name: 'executionDate', label: 'Date of execution', type: 'date', required: true },
  { name: 'placeOfExecution', label: 'Place of execution', placeholder: 'Bhubaneswar, Odisha', required: true },
  { name: 'agentName', label: 'Agent name (as it appears in the deed)', required: true },
  { name: 'serviceDescription', label: 'Services to be provided', required: true },
  { name: 'termMonths', label: 'Term (months)', type: 'number', required: true },
  { name: 'startDate', label: 'Commencement date', type: 'date', required: true },
  { name: 'consideration', label: 'Consideration', placeholder: 'Rs. 4,50,000 (Rupees four lakh fifty thousand only)', required: true },
];

const PARTIES = [
  { key: 'AGENT', label: 'Agent', note: 'Signs first, with an Aadhaar OTP.' },
  { key: 'EMPLOYEE', label: 'Employee', note: 'Reviews and approves the agent-signed document.' },
  { key: 'MD', label: 'Managing Director', note: 'Signs last; completion follows this signature.' },
] as const;

export function NewAgreementForm({ options }: { options: Option[] }) {
  const [state, action, pending] = useActionState(createAgreement, initial);
  const [typeId, setTypeId] = useState(options[0]?.type.id ?? '');

  const selected = options.find((o) => o.type.id === typeId);
  const templates = selected?.templates ?? [];

  if (options.length === 0) {
    return (
      <Notice tone="warn" title="No approved templates">
        An agreement cannot be created until an administrator has created a template and had it
        approved by someone other than its author.
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
        <div className="grid grid-2">
          {PARTICULARS.map((p) => (
            <Field
              key={p.name}
              label={p.label}
              name={`var.${p.name}`}
              type={p.type ?? 'text'}
              placeholder={p.placeholder}
              required={p.required}
            />
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Parties</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          All three are required, and they act strictly in this order. Nobody can act out of turn.
        </p>
        {PARTIES.map((party) => (
          <div key={party.key} style={{ marginBottom: 18 }}>
            <h3>
              {party.label} <span style={{ textTransform: 'none', fontWeight: 400 }}>— {party.note}</span>
            </h3>
            <div className="grid grid-3">
              <Field label="Full name" name={`${party.key}.name`} required minLength={2} />
              <Field label="Email" name={`${party.key}.email`} type="email" required />
              <Field label="Mobile (optional)" name={`${party.key}.mobile`} />
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

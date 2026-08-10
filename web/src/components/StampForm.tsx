'use client';

import { useActionState } from 'react';
import { registerStamp, type ActionResult } from '@/app/actions';
import { Notice, Field } from './ui';

const initial: ActionResult = {};

export function StampForm() {
  const [state, action, pending] = useActionState(registerStamp, initial);

  return (
    <div className="card">
      <h2>Register a stamp paper</h2>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      {state.ok && (
        <Notice tone="success">
          Registered. The scan was hashed on upload, so any later alteration is detectable.
        </Notice>
      )}

      <form action={action}>
        <Field
          label="Stamp / certificate number"
          name="stampNumber"
          placeholder="e.g. OR-2026-0004821"
          hint="Optional — some vendors do not print one. Must be unique where recorded."
        />
        <div className="grid grid-2">
          <Field label="Denomination (Rs.)" name="denomination" type="number" defaultValue={100} required />
          <Field
            label="Issuing state"
            name="stateCode"
            defaultValue="IN-OR"
            required
            hint="ISO 3166-2:IN"
          />
        </div>
        <div className="grid grid-2">
          <Field label="Issue date" name="issueDate" type="date" />
          <Field label="Vendor" name="vendor" placeholder="Treasury, Bhubaneswar" />
        </div>

        <div className="field">
          <label htmlFor="scan">Scan of the stamp paper</label>
          <input id="scan" name="scan" type="file" accept="application/pdf,image/png,image/jpeg" required />
          <div className="hint">PDF, PNG or JPEG, up to 10 MB. Stored privately and hashed on upload.</div>
        </div>

        <button type="submit" disabled={pending}>
          {pending ? 'Registering…' : 'Register stamp paper'}
        </button>
      </form>

      <p className="faint" style={{ marginBottom: 0, marginTop: 14 }}>
        The physical paper remains a legal artifact in its own right. GTIDS custody rules for the
        original are pending legal determination.
      </p>
    </div>
  );
}

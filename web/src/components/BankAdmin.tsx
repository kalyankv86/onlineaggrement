'use client';

import { useActionState, useState } from 'react';
import {
  createBank,
  designateSigner,
  uploadBankDocument,
  type ActionResult,
} from '@/app/actions';
import { Notice, Field } from './ui';

const initial: ActionResult = {};

export interface BankRow {
  id: string;
  code: string;
  name: string;
  contact_person: string | null;
  contact_email: string | null;
  employee_signer_user_id: string | null;
  is_active: boolean;
  agent_count: number;
  has_active_document: boolean;
}

export interface SignerOption {
  id: string;
  full_name: string;
  email: string;
}

/**
 * Bank administration (DEC-031, DEC-032, DEC-034).
 *
 * A bank is only usable once it has both a designated countersigner and an
 * active agreement document. Both are shown as outstanding against each bank,
 * because the alternative is an agent discovering it at the point of creating an
 * agreement — by which time they have the stamp paper in hand.
 */
export function BankAdmin({ banks, signers }: { banks: BankRow[]; signers: SignerOption[] }) {
  const [createState, createAction, creating] = useActionState(createBank, initial);
  const [signerState, signerAction, assigning] = useActionState(designateSigner, initial);
  const [docState, docAction, uploading] = useActionState(uploadBankDocument, initial);
  const [expanded, setExpanded] = useState<string | null>(null);

  const problem = [createState, signerState, docState].find((s) => s.error);
  const signerName = (id: string | null) =>
    signers.find((s) => s.id === id)?.full_name ?? null;

  return (
    <>
      {problem?.error && (
        <Notice tone="error" title={problem.rule ? `Refused — ${problem.rule}` : 'Refused'}>
          {problem.error}
        </Notice>
      )}
      {docState.ok && docState.message && <Notice tone="success">{docState.message}</Notice>}
      {signerState.ok && <Notice tone="success">Countersigner updated.</Notice>}

      <div className="card">
        <h2>Banks</h2>
        {banks.length === 0 ? (
          <p className="muted">
            No banks yet. Add one below, then give it a countersigner and its agreement document.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Bank</th>
                <th>Agents</th>
                <th>Countersigner</th>
                <th>Agreement</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {banks.map((bank) => {
                const ready = bank.has_active_document && bank.employee_signer_user_id;
                return (
                  <tr key={bank.id}>
                    <td>
                      <strong>{bank.name}</strong>
                      <div className="faint mono">{bank.code}</div>
                    </td>
                    <td>{bank.agent_count}</td>
                    <td>
                      {signerName(bank.employee_signer_user_id) ?? (
                        <span className="pill pill-waiting">not set</span>
                      )}
                    </td>
                    <td>
                      {bank.has_active_document ? (
                        <span className="pill pill-ok">active</span>
                      ) : (
                        <span className="pill pill-waiting">none</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => setExpanded(expanded === bank.id ? null : bank.id)}
                      >
                        {expanded === bank.id ? 'Close' : ready ? 'Manage' : 'Finish setup'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {expanded && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
            <h3>{banks.find((b) => b.id === expanded)?.name}</h3>

            <form action={signerAction} style={{ marginBottom: 24 }}>
              <input type="hidden" name="bankId" value={expanded} />
              <div className="field">
                <label htmlFor="employeeSignerUserId">GTIDS employee who countersigns</label>
                <select
                  id="employeeSignerUserId"
                  name="employeeSignerUserId"
                  defaultValue={
                    banks.find((b) => b.id === expanded)?.employee_signer_user_id ?? ''
                  }
                  required
                >
                  <option value="">Choose…</option>
                  {signers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name} ({s.email})
                    </option>
                  ))}
                </select>
                <div className="hint">
                  Internal staff holding the Employee role. An agent cannot be chosen — both
                  signatures would then sit on the same side of the agreement.
                </div>
              </div>
              <button type="submit" disabled={assigning}>
                {assigning ? 'Saving…' : 'Set countersigner'}
              </button>
            </form>

            <form action={docAction}>
              <input type="hidden" name="bankId" value={expanded} />
              <div className="field">
                <label htmlFor="document">This bank&apos;s agreement document</label>
                <input
                  id="document"
                  name="document"
                  type="file"
                  required
                  accept=".pdf,.doc,.docx,.odt,.rtf,application/pdf"
                />
                <div className="hint">
                  PDF or Word, up to 12 MB. Every agent at this bank executes this exact text, so
                  uploading replaces it for all of them. The previous version is kept, because
                  agreements already executed were executed from it.
                </div>
              </div>
              <button type="submit" disabled={uploading}>
                {uploading ? 'Uploading…' : 'Upload and activate'}
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Add a bank</h2>
        {createState.ok && <Notice tone="success">Bank added. Now set its countersigner and upload its agreement.</Notice>}
        <form action={createAction}>
          <div className="grid grid-2">
            <Field
              label="Short code"
              name="code"
              required
              hint="For operators, e.g. UBI. Not used in agreement numbers."
            />
            <Field label="Full name" name="name" required hint="e.g. Union Bank of India" />
          </div>
          <div className="grid grid-2">
            <Field label="Contact person (optional)" name="contactPerson" />
            <Field label="Contact email (optional)" name="contactEmail" type="email" />
          </div>
          <button type="submit" disabled={creating}>
            {creating ? 'Adding…' : 'Add bank'}
          </button>
        </form>
      </div>
    </>
  );
}

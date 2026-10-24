'use client';

import { useActionState, useState } from 'react';
import {
  upsertUser,
  setUserActive,
  resetUserPassword,
  type ActionResult,
} from '@/app/actions';
import { Notice, Field } from './ui';

const initial: ActionResult = {};

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  bank_id: string | null;
  bank_name: string | null;
  last_login_at: string | null;
  roles: string[];
}

export interface BankOption {
  id: string;
  name: string;
  is_active: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super Administrator',
  AGREEMENT_ADMIN: 'Agreement Administrator',
  AGENT: 'Agent (counterparty)',
  EMPLOYEE: 'GTIDS Employee (countersigns)',
  MD: 'Managing Director',
  MD_DELEGATE: 'MD Delegate',
  AUDITOR: 'Auditor',
};

/**
 * User administration.
 *
 * The form is built around the one rule that is easy to get wrong: an agent
 * belongs to a bank and holds no GTIDS role, and everyone else is the reverse.
 * Choosing Agent reveals the bank selector and hides the rest, so the invalid
 * combination is awkward to express rather than merely rejected afterwards.
 */
export function UserAdmin({ users, banks }: { users: UserRow[]; banks: BankOption[] }) {
  const [createState, createAction, creating] = useActionState(upsertUser, initial);
  const [activeState, activeAction, toggling] = useActionState(setUserActive, initial);
  const [resetState, resetAction, resetting] = useActionState(resetUserPassword, initial);
  const [isAgent, setIsAgent] = useState(false);

  const problem = [createState, activeState, resetState].find((s) => s.error);
  const usableBanks = banks.filter((b) => b.is_active);

  return (
    <>
      {problem?.error && (
        <Notice tone="error" title={problem.rule ? `Refused — ${problem.rule}` : 'Refused'}>
          {problem.error}
        </Notice>
      )}

      {/* Shown once. There is no way to retrieve it afterwards, only to reset again. */}
      {(createState.token || resetState.token) && (
        <Notice tone="warn" title="Copy this password now — it is shown once">
          <p className="mono" style={{ fontSize: '1.15rem', margin: '6px 0' }}>
            {createState.token ?? resetState.token}
          </p>
          Give it to them directly, not by email alongside their username, and have them change it
          after signing in. It cannot be retrieved later; losing it means another reset.
        </Notice>
      )}
      {activeState.ok && <Notice tone="success">Account updated.</Notice>}

      <div className="card">
        <h2>Accounts</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Roles</th>
              <th>Bank</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.is_active ? undefined : 'faint'}>
                <td>
                  <strong>{u.full_name}</strong>
                  <div className="faint mono">{u.email}</div>
                  {!u.is_active && <span className="badge badge-danger">deactivated</span>}
                </td>
                <td>
                  {u.roles.length === 0 ? (
                    <span className="badge badge-waiting">none</span>
                  ) : (
                    u.roles.map((r) => (
                      <div key={r} className="faint">
                        {ROLE_LABEL[r] ?? r}
                      </div>
                    ))
                  )}
                </td>
                <td>{u.bank_name ?? <span className="faint">—</span>}</td>
                <td className="faint">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('en-IN') : 'never'}
                </td>
                <td>
                  <div className="row">
                    <form action={resetAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button className="btn-ghost btn-sm" type="submit" disabled={resetting}>
                        Reset password
                      </button>
                    </form>
                    <form action={activeAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="isActive" value={u.is_active ? 'false' : 'true'} />
                      <button
                        className={u.is_active ? 'btn-danger btn-sm' : 'btn-secondary btn-sm'}
                        type="submit"
                        disabled={toggling}
                      >
                        {u.is_active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Add or update an account</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          An existing email updates that account and replaces its roles, rather than creating a
          second one. Its password is left alone unless you set one.
        </p>

        <form action={createAction}>
          <div className="grid grid-2">
            <Field label="Email" name="email" type="email" required />
            <Field label="Full name" name="fullName" required minLength={2} />
          </div>

          <div className="field">
            <label htmlFor="accountKind">What is this person?</label>
            <select
              id="accountKind"
              name="accountKind"
              value={isAgent ? 'AGENT' : 'INTERNAL'}
              onChange={(e) => setIsAgent(e.target.value === 'AGENT')}
            >
              <option value="INTERNAL">GTIDS staff</option>
              <option value="AGENT">An agent at a bank (counterparty)</option>
            </select>
          </div>

          {isAgent ? (
            <>
              <input type="hidden" name="roles" value="AGENT" />
              <div className="field">
                <label htmlFor="bankId">Which bank?</label>
                <select id="bankId" name="bankId" required>
                  <option value="">Choose…</option>
                  {usableBanks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  This decides which agreement they execute. An agent holds no GTIDS role — they
                  are the other side of the agreement.
                </div>
              </div>
              {usableBanks.length === 0 && (
                <Notice tone="warn">
                  No active banks yet. Add one under Banks before creating agents.
                </Notice>
              )}
            </>
          ) : (
            <div className="field">
              <label>Roles</label>
              <div className="hint" style={{ marginTop: 0 }}>
                Signing and administration are separate. Someone who both administers the system
                and countersigns needs both roles.
              </div>
              {(['SUPER_ADMIN', 'AGREEMENT_ADMIN', 'EMPLOYEE', 'MD', 'MD_DELEGATE', 'AUDITOR'] as const).map(
                (role) => (
                  <label key={role} className="checkbox-row">
                    <input type="checkbox" name="roles" value={role} />
                    <span>{ROLE_LABEL[role]}</span>
                  </label>
                ),
              )}
            </div>
          )}

          <Field
            label="Password (optional)"
            name="password"
            minLength={12}
            hint="Leave blank to have one generated and shown once. At least 12 characters."
          />

          <button type="submit" disabled={creating}>
            {creating ? 'Saving…' : 'Save account'}
          </button>
        </form>
      </div>
    </>
  );
}

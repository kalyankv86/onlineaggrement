'use client';

import { useActionState } from 'react';
import { composeFromBank, type ActionResult } from '@/app/actions';
import { Notice } from './ui';

const initial: ActionResult = {};

/**
 * Compose the agreement from the bank's own document (DEC-032).
 *
 * There is no file picker, and that is the point: the text belongs to the bank,
 * so an agent has nothing to choose. If they could, one agent could execute
 * wording GTIDS never agreed with the bank — and the signatures would be exactly
 * as valid as on the right text.
 */
export function BankAgreementCompose({
  agreementId,
  bankName,
  hasStamp,
}: {
  agreementId: string;
  bankName: string;
  hasStamp: boolean;
}) {
  const [state, action, pending] = useActionState(composeFromBank, initial);

  return (
    <div className="card">
      <h2>Prepare the agreement</h2>

      {state.error && (
        <Notice tone="error" title={state.rule ? `Refused — ${state.rule}` : 'Could not compose'}>
          {state.error}
        </Notice>
      )}
      {state.ok && state.message && <Notice tone="success">{state.message}</Notice>}

      {!hasStamp && (
        <Notice tone="warn" title="Allocate the stamp paper first">
          The stamp scan becomes page 1 of the executed document, so it has to be attached before
          the agreement.
        </Notice>
      )}

      <p>
        This agreement uses <strong>{bankName}</strong>&apos;s current agreement document. You do
        not upload anything — every agent at this bank executes the same text, which is held and
        versioned by an administrator.
      </p>

      <form action={action}>
        <input type="hidden" name="agreementId" value={agreementId} />
        <button type="submit" disabled={pending || !hasStamp}>
          {pending ? 'Composing…' : 'Compose the agreement'}
        </button>
      </form>

      <p className="faint" style={{ marginBottom: 0 }}>
        Read the composed document before you sign. If the text is wrong for this engagement, stop
        and tell an administrator — it cannot be changed once any signature is applied.
      </p>
    </div>
  );
}

'use client';

import { useActionState, useState } from 'react';
import {
  startSigning,
  rejectAgreement,
  correctAgreement,
  cancelAgreement,
  type ActionResult,
} from '@/app/actions';
import { Notice } from './ui';
import type { AgreementStatus } from '@/lib/api';

const initial: ActionResult = {};

interface Props {
  agreementId: string;
  status: AgreementStatus;
  availableActions: string[];
  documentHash: string | null;
  hasStamp: boolean;
}

/**
 * What a user may do comes from `availableActions`, which the API derives from the
 * transition table. The UI never decides authority itself — if it did, it would
 * drift from the state machine, and the disagreement would surface as a confusing
 * 409 rather than a hidden button.
 */
export function ActionPanel({
  agreementId,
  status,
  availableActions,
  documentHash,
  hasStamp,
}: Props) {
  const can = (action: string) => availableActions.includes(action);

  const [signState, signAction, signPending] = useActionState(startSigning, initial);
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectAgreement, initial);
  const [correctState, correctAction, correctPending] = useActionState(correctAgreement, initial);
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelAgreement, initial);

  const [showReject, setShowReject] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  const problem = [signState, rejectState, correctState, cancelState].find(
    (s) => s.error,
  );

  // GENERATE is offered by the upload panel, not here (DEC-025).
  const nothingToDo =
    !can('AGENT_SIGN_INITIATE') &&
    !can('MD_SIGN_INITIATE') &&
    !can('REJECT') &&
    !can('CORRECT') &&
    !can('CANCEL');

  return (
    <div className="card">
      <h2>Your actions</h2>

      {problem?.error && (
        <Notice tone="error" title={problem.rule ? `Refused — ${problem.rule}` : 'Refused'}>
          {problem.error}
        </Notice>
      )}

      {signState.ceremonyUrl && (
        <Notice tone="info" title="Signing ceremony ready">
          You will be taken to the licensed eSign provider to authenticate with an Aadhaar OTP.
          GTIDS never sees your Aadhaar number or the OTP — only the document digest is sent.
          <div style={{ marginTop: 10 }}>
            <a className="btn" href={signState.ceremonyUrl} target="_blank" rel="noreferrer">
              Continue to eSign provider ↗
            </a>
          </div>
          <div className="faint" style={{ marginTop: 8 }}>
            After signing, return here and refresh to see the updated status.
          </div>
        </Notice>
      )}

      {nothingToDo && !signState.ceremonyUrl && (
        <p className="muted" style={{ margin: 0 }}>
          {status === 'COMPLETED'
            ? 'This agreement is complete. No further action is possible.'
            : 'Nothing is waiting on you at this stage.'}
        </p>
      )}

      <div className="row">
        {can('AGENT_SIGN_INITIATE') && documentHash && (
          <form action={signAction}>
            <input type="hidden" name="agreementId" value={agreementId} />
            <input type="hidden" name="party" value="agent" />
            {/* The hash the signer was shown. A mismatch is refused (FR-027). */}
            <input type="hidden" name="documentHash" value={documentHash} />
            <button type="submit" disabled={signPending}>
              {signPending ? 'Starting…' : 'Sign as Agent'}
            </button>
          </form>
        )}

        {can('MD_SIGN_INITIATE') && documentHash && (
          <form action={signAction}>
            <input type="hidden" name="agreementId" value={agreementId} />
            <input type="hidden" name="party" value="md" />
            <input type="hidden" name="documentHash" value={documentHash} />
            <button type="submit" disabled={signPending}>
              {signPending ? 'Starting…' : 'Sign as Managing Director'}
            </button>
          </form>
        )}

        {can('CORRECT') && (
          <form action={correctAction}>
            <input type="hidden" name="agreementId" value={agreementId} />
            <button className="btn-secondary" type="submit" disabled={correctPending}>
              {correctPending ? 'Opening…' : 'Correct and re-issue'}
            </button>
          </form>
        )}

        {can('REJECT') && !showReject && (
          <button className="btn-danger" type="button" onClick={() => setShowReject(true)}>
            Reject
          </button>
        )}

        {can('CANCEL') && !showCancel && (
          <button className="btn-ghost" type="button" onClick={() => setShowCancel(true)}>
            Cancel agreement
          </button>
        )}
      </div>

      {showReject && can('REJECT') && (
        <form action={rejectAction} style={{ marginTop: 16 }}>
          <input type="hidden" name="agreementId" value={agreementId} />
          <div className="field">
            <label htmlFor="reason">Reason for rejection</label>
            <textarea
              id="reason"
              name="reason"
              minLength={10}
              required
              placeholder="Explain what must change before this can be executed"
            />
            <div className="hint">
              Recorded permanently in the audit trail and sent to the earlier parties. At least
              10 characters.
            </div>
          </div>
          <div className="row">
            <button className="btn-danger" type="submit" disabled={rejectPending}>
              {rejectPending ? 'Rejecting…' : 'Confirm rejection'}
            </button>
            <button className="btn-ghost" type="button" onClick={() => setShowReject(false)}>
              Back
            </button>
          </div>
        </form>
      )}

      {showCancel && can('CANCEL') && (
        <form action={cancelAction} style={{ marginTop: 16 }}>
          <input type="hidden" name="agreementId" value={agreementId} />
          <div className="field">
            <label htmlFor="cancel-reason">Reason for cancellation</label>
            <textarea id="cancel-reason" name="reason" minLength={10} required />
            <div className="hint">
              Cancellation is final — the agreement cannot be corrected afterwards, and the stamp
              paper returns to inventory.
            </div>
          </div>
          <div className="row">
            <button className="btn-danger" type="submit" disabled={cancelPending}>
              {cancelPending ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
            <button className="btn-ghost" type="button" onClick={() => setShowCancel(false)}>
              Back
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

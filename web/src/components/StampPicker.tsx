'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { allocateStamp, type ActionResult } from '@/app/actions';
import { Notice } from './ui';
import type { StampPaper } from '@/lib/api';

const initial: ActionResult = {};

/**
 * Allocation is exclusive: the database holds a partial unique index, so exactly
 * one agreement can hold a given stamp at a time (BR-006). If two operators pick
 * the same stamp at once, the loser gets a clear conflict rather than a duplicate.
 */
export function StampPicker({
  agreementId,
  stamps,
}: {
  agreementId: string;
  stamps: StampPaper[];
}) {
  const [state, action, pending] = useActionState(allocateStamp, initial);

  return (
    <div className="card">
      <h2>Allocate stamp paper</h2>
      {state.error && (
        <Notice tone="error" title={state.rule ? `Refused — ${state.rule}` : 'Refused'}>
          {state.error}
        </Notice>
      )}

      {stamps.length === 0 ? (
        <>
          <p className="muted">No stamp papers are available in inventory.</p>
          <Link className="btn btn-secondary btn-sm" href="/stamps">
            Register a stamp paper
          </Link>
        </>
      ) : (
        <form action={action}>
          <input type="hidden" name="agreementId" value={agreementId} />
          <div className="field">
            <label htmlFor="stampId">Available stamps</label>
            <select id="stampId" name="stampId" required>
              {stamps.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.stamp_number ?? 'unnumbered'} — Rs. {s.denomination} · {s.state_code}
                  {s.vendor ? ` · ${s.vendor}` : ''}
                </option>
              ))}
            </select>
            <div className="hint">
              A stamp can be attached to only one agreement. It is consumed when the agreement
              completes.
            </div>
          </div>
          <button type="submit" disabled={pending}>
            {pending ? 'Allocating…' : 'Allocate stamp'}
          </button>
        </form>
      )}
    </div>
  );
}

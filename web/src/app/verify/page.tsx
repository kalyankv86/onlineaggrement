import { redirect } from 'next/navigation';

export const metadata = { title: 'Verify an agreement — GTIDS' };

/**
 * Public entry point. Deliberately outside the authenticated shell: a counterparty
 * verifying a deed has no account and should need none.
 */
export default function VerifyEntryPage() {
  async function submit(form: FormData) {
    'use server';
    const token = String(form.get('token') ?? '')
      .trim()
      .toUpperCase();
    redirect(`/verify/${encodeURIComponent(token)}`);
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand-lg">
          <strong>Verify an agreement</strong>
          <span>Gramtarang Inclusive Development Services</span>
        </div>

        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Scan the QR code printed on the agreement, or enter the verification code below.
          </p>
          <form action={submit}>
            <div className="field">
              <label htmlFor="token">Verification code</label>
              <input
                id="token"
                name="token"
                required
                autoFocus
                className="mono"
                maxLength={32}
                minLength={32}
                placeholder="32-character code"
                style={{ letterSpacing: '.05em' }}
              />
              <div className="hint">
                Found beneath the QR code on the completed agreement. The agreement number is not a
                verification code.
              </div>
            </div>
            <button type="submit" style={{ width: '100%' }}>
              Verify
            </button>
          </form>
        </div>

        <p className="faint" style={{ textAlign: 'center', marginTop: 16 }}>
          Verification confirms that an agreement exists and is complete. It never reveals the
          parties, their contact details, or the contents of the agreement.
        </p>
      </div>
    </main>
  );
}

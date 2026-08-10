import Link from 'next/link';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/workflow';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Verification result — GTIDS' };

interface PublicVerification {
  found: boolean;
  rateLimited?: boolean;
  agreementNumber?: string;
  agreementType?: string;
  status?: string;
  completedAt?: string;
  documentHash?: string;
  signatures?: { party: string; signedAt: string }[];
}

const PARTY_LABEL: Record<string, string> = {
  AGENT: 'Agent',
  EMPLOYEE: 'Employee (approval)',
  MD: 'Managing Director',
};

export default async function VerifyResultPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Unauthenticated on purpose — this is the counterparty's view.
  const result = await api<PublicVerification>(`/api/v1/verify/${encodeURIComponent(token)}`, {
    auth: false,
  }).catch(() => ({ found: false }) as PublicVerification);

  return (
    <main className="auth">
      <div className="auth-card" style={{ maxWidth: 460 }}>
        <div className="brand-lg">
          <strong>Agreement verification</strong>
          <span>Gramtarang Inclusive Development Services</span>
        </div>

        {result.rateLimited ? (
          <div className="card">
            <div className="notice notice-warn" style={{ marginBottom: 0 }}>
              <strong>Too many attempts</strong>
              Wait a minute and try again.
            </div>
          </div>
        ) : !result.found ? (
          <div className="card">
            <div className="notice notice-error" style={{ marginBottom: 12 }}>
              <strong>No agreement matches this code</strong>
              The code may be mistyped, or the agreement may not be complete.
            </div>
            <p className="faint" style={{ marginTop: 0 }}>
              Verification codes are 32 characters and are printed beneath the QR code on the
              completed agreement. An agreement number cannot be used here.
            </p>
            <Link className="btn btn-secondary" href="/verify">
              Try another code
            </Link>
          </div>
        ) : (
          <div className="card">
            <div className="notice notice-success">
              <strong>This is a genuine GTIDS agreement</strong>
              {result.status === 'COMPLETED'
                ? 'Fully executed by all three parties.'
                : `Current status: ${result.status?.replace(/_/g, ' ').toLowerCase()}.`}
            </div>

            <dl className="pairs">
              <dt>Agreement</dt>
              <dd className="mono">{result.agreementNumber}</dd>
              <dt>Type</dt>
              <dd>{result.agreementType}</dd>
              {result.completedAt && (
                <>
                  <dt>Completed</dt>
                  <dd>{formatDate(result.completedAt)}</dd>
                </>
              )}
            </dl>

            {result.signatures && result.signatures.length > 0 && (
              <>
                <h3 style={{ marginTop: 18 }}>Execution record</h3>
                <ul className="timeline">
                  {result.signatures.map((s, i) => (
                    <li key={i} className="emphasis">
                      <div className="t-title">{PARTY_LABEL[s.party] ?? s.party}</div>
                      <div className="t-meta">{formatDate(s.signedAt)}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {result.documentHash && (
              <div style={{ marginTop: 14 }}>
                <div className="faint">Document fingerprint (SHA-256)</div>
                <code style={{ wordBreak: 'break-all' }}>{result.documentHash}</code>
                <div className="faint" style={{ marginTop: 6 }}>
                  A copy of the agreement whose fingerprint differs from this is not the executed
                  document.
                </div>
              </div>
            )}
          </div>
        )}

        <p className="faint" style={{ textAlign: 'center', marginTop: 16 }}>
          For privacy, this page never shows party names, contact details or the contents of the
          agreement.
        </p>
      </div>
    </main>
  );
}

import Link from 'next/link';
import {
  get,
  proxied,
  type AgreementDetail,
  type VerificationReport,
  type AuditEntry,
  type StampPaper,
} from '@/lib/api';
import { StatusBadge, ProgressRail, Notice } from '@/components/ui';
import { ActionPanel } from '@/components/ActionPanel';
import { StampPicker } from '@/components/StampPicker';
import { formatDate, formatDateOnly, AUDIT_LABEL, shortHash } from '@/lib/workflow';
import { currentPrincipal, hasRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await currentPrincipal();
  const agreement = await get<AgreementDetail>(`/api/v1/agreements/${id}`);

  const generated = agreement.status !== 'DRAFT';

  // These are best-effort: a DRAFT has no document yet, and only privileged roles
  // may read the audit trail. A missing panel is better than a failed page.
  const [document, report, audit, stamps] = await Promise.all([
    generated
      ? get<{ url: string; documentHash: string; signatureState: string }>(
          `/api/v1/agreements/${id}/document`,
        ).catch(() => null)
      : null,
    generated
      ? get<VerificationReport>(`/api/v1/agreements/${id}/verify-signatures`).catch(() => null)
      : null,
    hasRole(principal, 'AUDITOR', 'AGREEMENT_ADMIN', 'SUPER_ADMIN', 'MD')
      ? get<{ entries: AuditEntry[]; chain: { intact: boolean; recordCount: number } }>(
          `/api/v1/agreements/${id}/audit`,
        ).catch(() => null)
      : null,
    agreement.status === 'DRAFT' && !agreement.stamp
      ? get<StampPaper[]>('/api/v1/stamps/available?denomination=100').catch(() => [])
      : [],
  ]);

  const qr =
    agreement.status === 'COMPLETED'
      ? await get<{ url: string | null; dataUri: string | null }>(`/api/v1/agreements/${id}/qr`).catch(
          () => null,
        )
      : null;

  return (
    <>
      <div className="spread">
        <div>
          <Link href="/agreements" className="faint" style={{ textDecoration: 'none' }}>
            ← All agreements
          </Link>
          <h1 className="mono" style={{ fontSize: 20, marginTop: 6 }}>
            {agreement.agreement_number}
          </h1>
          <div className="row">
            <StatusBadge status={agreement.status} />
            <span className="faint">version {agreement.current_version}</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <ProgressRail status={agreement.status} />
      </div>

      {agreement.status === 'REJECTED' && agreement.rejected_reason && (
        <div style={{ marginTop: 16 }}>
          <Notice tone="error" title="Rejected">
            {agreement.rejected_reason}
            <div className="faint" style={{ marginTop: 6 }}>
              Correcting this opens version {agreement.current_version + 1}. Signatures collected on
              the current version are voided — a corrected document is a different document.
            </div>
          </Notice>
        </div>
      )}

      {report && !report.allValid && (
        <div style={{ marginTop: 16 }}>
          <Notice tone="error" title="Signature integrity problem">
            One or more signatures on this document no longer verify. Do not rely on this
            document; report it to GTIDS immediately.
          </Notice>
        </div>
      )}

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div>
          {/* ── The document being acted on ──────────────────────────────── */}
          <div className="card">
            <h2>Document</h2>
            {!generated ? (
              <p className="muted" style={{ margin: 0 }}>
                Not generated yet. {agreement.stamp ? '' : 'Allocate a stamp paper first.'}
              </p>
            ) : document ? (
              <>
                <dl className="pairs">
                  <dt>State</dt>
                  <dd>{document.signatureState.replace(/_/g, ' ').toLowerCase()}</dd>
                  <dt>Signatures</dt>
                  <dd>
                    {report ? (
                      <>
                        {report.count} applied ·{' '}
                        <span style={{ color: report.allValid ? 'var(--success)' : 'var(--danger)' }}>
                          {report.allValid ? 'all valid' : 'INVALID'}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </dd>
                </dl>

                <div style={{ margin: '12px 0' }}>
                  <div className="faint">SHA-256 of the document you are acting on</div>
                  <code style={{ wordBreak: 'break-all' }}>{document.documentHash}</code>
                </div>

                <a className="btn btn-secondary" href={proxied(document.url)} target="_blank" rel="noreferrer">
                  Open document ↗
                </a>
                <div className="faint" style={{ marginTop: 8 }}>
                  This link is authorised for you and expires in a few minutes.
                </div>

                {report && report.signatures.length > 0 && (
                  <div style={{ marginTop: 18 }}>
                    <h3>Applied signatures</h3>
                    <ul className="timeline">
                      {report.signatures.map((s) => (
                        <li key={s.index} className={s.valid ? 'emphasis' : 'alarm'}>
                          <div className="t-title">
                            {s.signerCommonName ?? `Signature ${s.index}`}{' '}
                            <span
                              className="badge badge-{s.valid ? 'success' : 'danger'}"
                              style={{
                                marginLeft: 6,
                                background: s.valid ? 'var(--success-soft)' : 'var(--danger-soft)',
                                color: s.valid ? 'var(--success)' : 'var(--danger)',
                              }}
                            >
                              {s.valid ? 'valid' : 'invalid'}
                            </span>
                          </div>
                          <div className="t-meta">
                            covers {s.coversBytes.toLocaleString()} bytes
                            {s.coversWholeFile
                              ? ' — the whole document'
                              : ' — a prefix; later revisions were appended after it'}
                          </div>
                          {s.issues.map((issue) => (
                            <div key={issue} className="t-meta" style={{ color: 'var(--danger)' }}>
                              {issue}
                            </div>
                          ))}
                        </li>
                      ))}
                    </ul>
                    <p className="faint" style={{ marginTop: 4 }}>
                      Each signature is applied as an append-only revision, so a later signature
                      cannot invalidate an earlier one.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p className="muted">You do not have access to this document.</p>
            )}
          </div>

          {/* ── Actions ──────────────────────────────────────────────────── */}
          <ActionPanel
            agreementId={agreement.id}
            status={agreement.status}
            availableActions={agreement.availableActions}
            documentHash={document?.documentHash ?? null}
            hasStamp={!!agreement.stamp}
          />

          {agreement.status === 'DRAFT' && !agreement.stamp && (
            <StampPicker agreementId={agreement.id} stamps={stamps ?? []} />
          )}
        </div>

        <div>
          {/* ── Parties ──────────────────────────────────────────────────── */}
          <div className="card">
            <h2>Parties</h2>
            <ul className="timeline">
              {agreement.parties
                .sort((a, b) => a.signing_order - b.signing_order)
                .map((p) => (
                  <li key={p.id} className={p.status === 'ACTED' ? 'emphasis' : ''}>
                    <div className="t-title">{p.name}</div>
                    <div className="t-meta">
                      {p.party_type} · {p.email}
                      {p.status === 'ACTED' && ' · acted'}
                    </div>
                  </li>
                ))}
            </ul>
          </div>

          {/* ── Stamp ────────────────────────────────────────────────────── */}
          <div className="card">
            <h2>Stamp paper</h2>
            {agreement.stamp ? (
              <dl className="pairs">
                <dt>Number</dt>
                <dd className="mono">{agreement.stamp.stamp_number ?? 'not recorded'}</dd>
                <dt>Denomination</dt>
                <dd>Rs. {agreement.stamp.denomination}</dd>
                <dt>State</dt>
                <dd>{agreement.stamp.state_code}</dd>
              </dl>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                No stamp allocated.
              </p>
            )}
          </div>

          {/* ── Detail ───────────────────────────────────────────────────── */}
          <div className="card">
            <h2>Details</h2>
            <dl className="pairs">
              <dt>Created</dt>
              <dd>{formatDate(agreement.created_at)}</dd>
              {agreement.expires_at && agreement.status !== 'COMPLETED' && (
                <>
                  <dt>Deadline</dt>
                  <dd>{formatDate(agreement.expires_at)}</dd>
                </>
              )}
              {agreement.completed_at && (
                <>
                  <dt>Completed</dt>
                  <dd>{formatDate(agreement.completed_at)}</dd>
                </>
              )}
              {agreement.place_of_execution_state && (
                <>
                  <dt>Place</dt>
                  <dd>{agreement.place_of_execution_state}</dd>
                </>
              )}
            </dl>

            {Object.keys(agreement.data ?? {}).length > 0 && (
              <>
                <h3 style={{ marginTop: 18 }}>Agreement particulars</h3>
                <dl className="pairs">
                  {Object.entries(agreement.data).map(([key, value]) => (
                    <div key={key} style={{ display: 'contents' }}>
                      <dt>{humanise(key)}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>

          {/* ── Public verification ──────────────────────────────────────── */}
          {qr?.url && (
            <div className="card">
              <h2>Public verification</h2>
              <p className="faint" style={{ marginTop: 0 }}>
                Anyone holding this code can confirm the agreement is genuine without seeing any
                party details.
              </p>
              {qr.dataUri && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qr.dataUri}
                  alt="Verification QR code"
                  width={150}
                  height={150}
                  style={{ borderRadius: 8, background: '#fff', padding: 6 }}
                />
              )}
              <div style={{ marginTop: 10 }}>
                <a className="mono" href={qr.url} target="_blank" rel="noreferrer">
                  {qr.url}
                </a>
              </div>
            </div>
          )}

          {/* ── Versions ─────────────────────────────────────────────────── */}
          {agreement.versions?.length > 0 && (
            <div className="card">
              <h2>Document versions</h2>
              <ul className="timeline">
                {agreement.versions.map((v, i) => (
                  <li key={`${v.version_no}-${v.signature_state}-${i}`}>
                    <div className="t-title">
                      v{v.version_no} · {v.signature_state.replace(/_/g, ' ').toLowerCase()}
                    </div>
                    <div className="t-meta mono">{shortHash(v.document_hash)}</div>
                    <div className="t-meta">{formatDate(v.created_at)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* ── Audit trail ────────────────────────────────────────────────────── */}
      {audit && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="spread">
            <h2>Audit trail</h2>
            <span
              className={`badge badge-${audit.chain.intact ? 'success' : 'danger'}`}
              title="Each record is hash-chained to its predecessor"
            >
              {audit.chain.intact
                ? `chain intact · ${audit.chain.recordCount} records`
                : 'CHAIN BROKEN'}
            </span>
          </div>
          <ul className="timeline">
            {audit.entries.map((e) => (
              <li
                key={e.id}
                className={
                  e.event_type.includes('ALERT') || e.event_type.includes('BROKEN')
                    ? 'alarm'
                    : e.event_type.includes('SIGNED') || e.event_type === 'AGREEMENT_COMPLETED'
                      ? 'emphasis'
                      : ''
                }
              >
                <div className="t-title">{AUDIT_LABEL[e.event_type] ?? e.event_type}</div>
                <div className="t-meta">
                  {formatDate(e.created_at)}
                  {e.actor_name ? ` · ${e.actor_name}` : ''}
                  {e.ip_address ? ` · ${e.ip_address}` : ''}
                  {e.agreement_version ? ` · v${e.agreement_version}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

const humanise = (key: string): string =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentPrincipal, hasRole } from '@/lib/session';
import { logout } from '../actions';

/**
 * Authenticated shell. Every page beneath it requires a session; an expired token
 * bounces to /login rather than rendering a broken page.
 *
 * Navigation is filtered by role for tidiness only — authority is enforced by the
 * API, so hiding a link is presentation, never protection.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const principal = await currentPrincipal();
  if (!principal) redirect('/login');

  const isAdmin = hasRole(principal, 'AGREEMENT_ADMIN', 'SUPER_ADMIN');
  const canReport = hasRole(principal, 'AGREEMENT_ADMIN', 'SUPER_ADMIN', 'AUDITOR', 'MD');
  const scoped = !!principal.scopedAgreementId;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <strong>GTIDS Agreements</strong>
          <span>Digital signing portal</span>
        </div>

        {scoped ? (
          <Link className="nav-link" href={`/agreements/${principal.scopedAgreementId}`}>
            Your agreement
          </Link>
        ) : (
          <>
            <Link className="nav-link" href="/agreements">
              Agreements
            </Link>
            {hasRole(principal, 'AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN') && (
              <Link className="nav-link" href="/agreements/new">
                New agreement
              </Link>
            )}

            {isAdmin && (
              <>
                <div className="nav-section">Administration</div>
                <Link className="nav-link" href="/stamps">
                  Stamp inventory
                </Link>
                <Link className="nav-link" href="/templates">
                  Templates
                </Link>
              </>
            )}

            {canReport && (
              <>
                <div className="nav-section">Oversight</div>
                <Link className="nav-link" href="/reports">
                  Reports
                </Link>
              </>
            )}
          </>
        )}

        <div className="nav-section">Public</div>
        <Link className="nav-link" href="/verify">
          Verify an agreement
        </Link>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="faint">
            {scoped ? 'External party access — scoped to one agreement' : 'Signed in'}
          </div>
          <div className="row">
            <div style={{ textAlign: 'right', lineHeight: 1.3 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{principal.fullName}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                {(principal.effectiveRoles ?? principal.roles ?? []).join(', ')}
              </div>
            </div>
            <form action={logout}>
              <button className="btn-ghost btn-sm" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

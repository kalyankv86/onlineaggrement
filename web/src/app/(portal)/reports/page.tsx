import { get } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Summary {
  byStatus: { status: string; count: string }[];
  byType: { code: string; name: string; count: string }[];
  completion: { completed: string; avg_hours_to_complete: string | null } | null;
}
interface Aging {
  status: string;
  count: string;
  avg_days_in_state: string | null;
  overdue: string;
}
interface Integrity {
  chains: number;
  totalRecords: number;
  suspectChains: string[];
  intact: boolean;
}
interface Signatures {
  byStatus: { provider: string; status: string; count: string; avg_attempts: string }[];
  topFailures: { failure_code: string; count: string }[];
}

export default async function ReportsPage() {
  const [summary, aging, integrity, signatures, notifications] = await Promise.all([
    get<Summary>('/api/v1/reports/agreements').catch(() => null),
    get<Aging[]>('/api/v1/reports/workflow-aging').catch(() => []),
    get<Integrity>('/api/v1/reports/audit-integrity').catch(() => null),
    get<Signatures>('/api/v1/reports/signatures').catch(() => null),
    get<{ event_type: string; status: string; count: string }[]>(
      '/api/v1/reports/notifications',
    ).catch(() => []),
  ]);

  const total = summary?.byStatus.reduce((s, r) => s + Number(r.count), 0) ?? 0;
  const completed = Number(summary?.completion?.completed ?? 0);
  const avgHours = summary?.completion?.avg_hours_to_complete;
  const overdue = aging.reduce((s, r) => s + Number(r.overdue), 0);

  return (
    <>
      <h1>Reports</h1>
      <p className="page-sub">Operational and management reporting across the agreement register.</p>

      <div className="grid grid-3">
        <div className="card">
          <div className="stat">{total}</div>
          <div className="stat-label">agreements</div>
        </div>
        <div className="card">
          <div className="stat">{completed}</div>
          <div className="stat-label">completed</div>
        </div>
        <div className="card">
          <div className="stat">{avgHours ? `${Math.round(Number(avgHours))}h` : '—'}</div>
          <div className="stat-label">average time to complete</div>
        </div>
        <div className="card">
          <div className="stat" style={{ color: overdue > 0 ? 'var(--danger)' : undefined }}>
            {overdue}
          </div>
          <div className="stat-label">past their deadline</div>
        </div>
      </div>

      {/* Audit integrity is placed first among the detail panels: it is the one
          number on this page that means something has gone seriously wrong. */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="spread">
          <h2>Audit integrity</h2>
          {integrity && (
            <span className={`badge badge-${integrity.intact ? 'success' : 'danger'}`}>
              {integrity.intact ? 'all chains intact' : `${integrity.suspectChains.length} suspect`}
            </span>
          )}
        </div>
        {integrity ? (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              {integrity.totalRecords.toLocaleString()} audit records across {integrity.chains}{' '}
              hash chains. Each record binds the hash of its predecessor, so removing or altering
              one is detectable even by someone holding database privileges.
            </p>
            {!integrity.intact && (
              <div className="notice notice-error">
                <strong>Investigate immediately</strong>
                Chains with a mismatch: {integrity.suspectChains.join(', ')}
              </div>
            )}
          </>
        ) : (
          <p className="muted">Not available.</p>
        )}
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Where agreements are waiting</h2>
          {aging.length === 0 ? (
            <p className="muted">Nothing in flight.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>State</th>
                    <th>Count</th>
                    <th>Avg days</th>
                    <th>Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {aging.map((r) => (
                    <tr key={r.status}>
                      <td>{r.status.replace(/_/g, ' ').toLowerCase()}</td>
                      <td>{r.count}</td>
                      <td className="muted">{r.avg_days_in_state ?? '—'}</td>
                      <td style={{ color: Number(r.overdue) > 0 ? 'var(--danger)' : undefined }}>
                        {r.overdue}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2>By agreement type</h2>
          {summary?.byType.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byType.map((r) => (
                    <tr key={r.code}>
                      <td>{r.name}</td>
                      <td>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No data.</p>
          )}
        </div>

        <div className="card">
          <h2>Signing transactions</h2>
          {signatures?.byStatus.length ? (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Status</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signatures.byStatus.map((r, i) => (
                      <tr key={i}>
                        <td>{r.provider}</td>
                        <td>{r.status.toLowerCase()}</td>
                        <td>{r.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {signatures.topFailures.length > 0 && (
                <>
                  <h3 style={{ marginTop: 16 }}>Most common failures</h3>
                  <ul className="faint" style={{ paddingLeft: 18, margin: 0 }}>
                    {signatures.topFailures.map((f) => (
                      <li key={f.failure_code}>
                        {f.failure_code} — {f.count}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <p className="muted">No signing transactions yet.</p>
          )}
        </div>

        <div className="card">
          <h2>Notification delivery</h2>
          {notifications.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {notifications.map((r, i) => (
                    <tr key={i}>
                      <td>{r.event_type.replace(/_/g, ' ').toLowerCase()}</td>
                      <td>{r.status.toLowerCase()}</td>
                      <td>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No notifications yet.</p>
          )}
          <p className="faint" style={{ marginBottom: 0, marginTop: 12 }}>
            Delivery is tracked per recipient, so one bounce cannot be mistaken for delivery to all
            three parties.
          </p>
        </div>
      </div>
    </>
  );
}

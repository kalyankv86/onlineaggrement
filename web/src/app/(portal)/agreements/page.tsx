import Link from 'next/link';
import { get, type AgreementSummary, type AgreementStatus } from '@/lib/api';
import { StatusBadge, Empty } from '@/components/ui';
import { formatDate, formatDateOnly } from '@/lib/workflow';
import { currentPrincipal, hasRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: AgreementSummary[];
}

const FILTERS: { label: string; status?: AgreementStatus }[] = [
  { label: 'All' },
  { label: 'Awaiting agent', status: 'READY_FOR_AGENT_SIGNATURE' },
  { label: 'Awaiting approval', status: 'PENDING_EMPLOYEE_APPROVAL' },
  { label: 'Awaiting MD', status: 'PENDING_MD_SIGNATURE' },
  { label: 'Completed', status: 'COMPLETED' },
  { label: 'Rejected', status: 'REJECTED' },
];

export default async function AgreementsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const principal = await currentPrincipal();
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.page) query.set('page', params.page);

  const data = await get<Page>(`/api/v1/agreements?${query.toString()}`);
  const overdue = (a: AgreementSummary) =>
    a.expires_at && new Date(a.expires_at) < new Date() && a.status !== 'COMPLETED';

  return (
    <>
      <div className="spread">
        <div>
          <h1>Agreements</h1>
          <p className="page-sub">
            {data.total} agreement{data.total === 1 ? '' : 's'} in the register
          </p>
        </div>
        {hasRole(principal, 'AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN') && (
          <Link className="btn" href="/agreements/new">
            New agreement
          </Link>
        )}
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        {FILTERS.map((f) => {
          const active = (params.status ?? '') === (f.status ?? '');
          return (
            <Link
              key={f.label}
              className={active ? 'btn btn-sm' : 'btn-secondary btn-sm btn'}
              href={f.status ? `/agreements?status=${f.status}` : '/agreements'}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <div className="card" style={{ padding: '16px 8px 8px' }}>
        {data.items.length === 0 ? (
          <Empty>
            <p>No agreements match this filter.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agreement</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Created</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link href={`/agreements/${a.id}`} className="mono">
                        {a.agreement_number}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="muted">v{a.current_version}</td>
                    <td className="muted">{formatDateOnly(a.created_at)}</td>
                    <td className={overdue(a) ? '' : 'muted'}>
                      {a.completed_at ? (
                        <span className="muted">completed {formatDateOnly(a.completed_at)}</span>
                      ) : overdue(a) ? (
                        <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                          overdue — {formatDate(a.expires_at)}
                        </span>
                      ) : (
                        formatDate(a.expires_at)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.total > data.pageSize && (
        <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
          {data.page > 1 && (
            <Link className="btn-secondary btn btn-sm" href={`/agreements?page=${data.page - 1}`}>
              Previous
            </Link>
          )}
          <span className="faint">
            Page {data.page} of {Math.ceil(data.total / data.pageSize)}
          </span>
          {data.page * data.pageSize < data.total && (
            <Link className="btn-secondary btn btn-sm" href={`/agreements?page=${data.page + 1}`}>
              Next
            </Link>
          )}
        </div>
      )}
    </>
  );
}

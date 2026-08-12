import { get, type StampPaper } from '@/lib/api';
import { StampScanForm } from '@/components/StampScanForm';
import { Empty } from '@/components/ui';
import { formatDateOnly } from '@/lib/workflow';

export const dynamic = 'force-dynamic';

interface InventoryRow {
  status: string;
  state_code: string;
  count: string;
  value: string;
}

export default async function StampsPage() {
  const [available, report] = await Promise.all([
    get<StampPaper[]>('/api/v1/stamps/available?denomination=100').catch(() => []),
    get<{ byStatus: InventoryRow[] }>('/api/v1/stamps/report').catch(() => ({ byStatus: [] })),
  ]);

  const totals = report.byStatus.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + Number(row.count);
    return acc;
  }, {});

  return (
    <>
      <h1>Stamp inventory</h1>
      <p className="page-sub">
        Physical Rs. 100 non-judicial stamp papers. Each can be attached to only one agreement, and
        is consumed when that agreement completes.
      </p>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        {(['AVAILABLE', 'ALLOCATED', 'USED', 'CANCELLED'] as const).map((status) => (
          <div className="card" key={status}>
            <div className="stat">{totals[status] ?? 0}</div>
            <div className="stat-label">{status.toLowerCase()}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-2">
        <StampScanForm />

        <div className="card">
          <h2>Available now</h2>
          {available.length === 0 ? (
            <Empty>
              <p>No stamp papers are available. Register one to create new agreements.</p>
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>State</th>
                    <th>Issued</th>
                    <th>Vendor</th>
                  </tr>
                </thead>
                <tbody>
                  {available.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.stamp_number ?? '—'}</td>
                      <td>{s.state_code}</td>
                      <td className="muted">{formatDateOnly(s.issue_date)}</td>
                      <td className="muted">{s.vendor ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

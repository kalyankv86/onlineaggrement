import { get } from '@/lib/api';
import { Empty } from '@/components/ui';
import { formatDate } from '@/lib/workflow';

export const dynamic = 'force-dynamic';

interface AgreementType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  requires_stamp: boolean;
  stamp_denomination: string;
}
interface Template {
  id: string;
  agreement_type_id: string;
  name: string;
  description: string | null;
}
interface Version {
  id: string;
  version_no: number;
  status: 'DRAFT' | 'APPROVED' | 'RETIRED';
  approved_at: string | null;
  created_at: string;
}

const TONE: Record<Version['status'], string> = {
  DRAFT: 'badge-neutral',
  APPROVED: 'badge-success',
  RETIRED: 'badge-danger',
};

export default async function TemplatesPage() {
  const types = await get<AgreementType[]>('/api/v1/templates/types');

  const data = await Promise.all(
    types.map(async (type) => {
      const templates = await get<Template[]>(
        `/api/v1/templates?agreementTypeId=${type.id}`,
      ).catch(() => []);
      const withVersions = await Promise.all(
        templates.map(async (t) => ({
          ...t,
          versions: await get<Version[]>(`/api/v1/templates/${t.id}/versions`).catch(() => []),
        })),
      );
      return { type, templates: withVersions };
    }),
  );

  return (
    <>
      <h1>Agreement templates</h1>
      <p className="page-sub">
        Template content is versioned and immutable once approved, so a completed agreement can
        always be reproduced from the exact text that was executed.
      </p>

      {data.length === 0 ? (
        <Empty>
          <p>No agreement types configured.</p>
        </Empty>
      ) : (
        data.map(({ type, templates }) => (
          <div className="card" key={type.id}>
            <div className="spread">
              <div>
                <h2 style={{ marginBottom: 2 }}>{type.name}</h2>
                <div className="faint">
                  <span className="mono">{type.code}</span>
                  {type.requires_stamp
                    ? ` · requires Rs. ${type.stamp_denomination} stamp paper`
                    : ' · no stamp required'}
                </div>
              </div>
            </div>

            {templates.length === 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                No templates for this type.
              </p>
            ) : (
              templates.map((t) => (
                <div key={t.id} style={{ marginTop: 16 }}>
                  <h3>{t.name}</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Version</th>
                          <th>Status</th>
                          <th>Created</th>
                          <th>Approved</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.versions.map((v) => (
                          <tr key={v.id}>
                            <td>v{v.version_no}</td>
                            <td>
                              <span className={`badge ${TONE[v.status]}`}>
                                {v.status.toLowerCase()}
                              </span>
                            </td>
                            <td className="muted">{formatDate(v.created_at)}</td>
                            <td className="muted">{formatDate(v.approved_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </div>
        ))
      )}

      <div className="card">
        <h2>How template approval works</h2>
        <ul className="muted" style={{ paddingLeft: 18, margin: 0 }}>
          <li>Only <strong>approved</strong> versions can be used to create an agreement.</li>
          <li>
            A version cannot be approved by the person who authored it — separation of duties on
            legal text.
          </li>
          <li>
            A template that uses a variable it has not declared is rejected at authoring time,
            because an undeclared placeholder would print literally in an executed deed.
          </li>
          <li>Retiring a version stops new use but keeps old agreements reproducible.</li>
        </ul>
      </div>
    </>
  );
}

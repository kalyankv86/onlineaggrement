import { get } from '@/lib/api';
import { NewAgreementForm } from '@/components/NewAgreementForm';

export const dynamic = 'force-dynamic';

interface AgreementType {
  id: string;
  code: string;
  name: string;
  requires_stamp: boolean;
  stamp_denomination: string;
  /** UPLOAD types carry no template — GTIDS supplies the document (DEC-025). */
  document_source: 'UPLOAD' | 'TEMPLATE';
}
interface Template {
  id: string;
  agreement_type_id: string;
  name: string;
}
interface TemplateVersion {
  id: string;
  version_no: number;
  status: string;
}

/**
 * Assembles the choices the form needs. Only APPROVED template versions are
 * offered — the API refuses anything else (FR-003), so offering a draft would only
 * produce a rejection at submit time.
 */
export default async function NewAgreementPage() {
  const types = await get<AgreementType[]>('/api/v1/templates/types');

  const options = await Promise.all(
    types.map(async (type) => {
      const templates = await get<Template[]>(
        `/api/v1/templates?agreementTypeId=${type.id}`,
      ).catch(() => []);

      const withVersions = await Promise.all(
        templates.map(async (t) => {
          const versions = await get<TemplateVersion[]>(`/api/v1/templates/${t.id}/versions`).catch(
            () => [],
          );
          const approved = versions.filter((v) => v.status === 'APPROVED');
          return { ...t, versions: approved };
        }),
      );

      return { type, templates: withVersions.filter((t) => t.versions.length > 0) };
    }),
  );

  // A TEMPLATE type is unusable without an approved template version. An UPLOAD
  // type needs none, so filtering on templates would hide it entirely.
  const usable = options.filter(
    (o) => o.type.document_source === 'UPLOAD' || o.templates.length > 0,
  );

  return (
    <>
      <h1>New agreement</h1>
      <p className="page-sub">
        The agreement is created as a draft. Nothing is composed or signed until you attach the
        stamp paper scan and the agreement document.
      </p>
      <NewAgreementForm options={usable} />
    </>
  );
}

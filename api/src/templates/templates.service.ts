import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX } from '../common/database/database.module';
import { AuditService } from '../audit/audit.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors/domain.errors';
import { mergeTemplate } from '../documents/pdf/renderer';

/**
 * Template lifecycle — FR-003.
 *
 * Template *content* is versioned and immutable once approved: agreements
 * reference a version, not a template, so a completed agreement can always be
 * regenerated from the exact text that was executed.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly audit: AuditService,
  ) {}

  async createTemplate(input: { agreementTypeId: string; name: string; description?: string }) {
    const type = await this.knex('agreement_types').where('id', input.agreementTypeId).first();
    if (!type) throw new NotFoundError('Agreement type', input.agreementTypeId);

    const [row] = await this.knex('agreement_templates')
      .insert({
        agreement_type_id: input.agreementTypeId,
        name: input.name,
        description: input.description ?? null,
      })
      .returning('*');
    return row;
  }

  async createVersion(input: {
    templateId: string;
    content: string;
    variablesSchema?: { required?: string[] };
    createdBy: string;
  }) {
    const template = await this.knex('agreement_templates').where('id', input.templateId).first();
    if (!template) throw new NotFoundError('Template', input.templateId);

    this.assertPlaceholdersDeclared(input.content, input.variablesSchema);

    const latest = await this.knex('agreement_template_versions')
      .where('template_id', input.templateId)
      .max<{ max: number }[]>('version_no as max')
      .first();

    const [row] = await this.knex('agreement_template_versions')
      .insert({
        template_id: input.templateId,
        version_no: (latest?.max ?? 0) + 1,
        content: input.content,
        variables_schema: JSON.stringify(input.variablesSchema ?? {}),
        status: 'DRAFT',
        created_by: input.createdBy,
      })
      .returning('*');
    return row;
  }

  /** Approval is the gate: only APPROVED versions may be instantiated (FR-002). */
  async approveVersion(versionId: string, approvedBy: string) {
    const version = await this.knex('agreement_template_versions').where('id', versionId).first();
    if (!version) throw new NotFoundError('Template version', versionId);
    if (version.status !== 'DRAFT') {
      throw new ConflictError(`Template version is ${version.status}, not DRAFT`, 'FR-003');
    }
    if (version.created_by === approvedBy) {
      // Separation of duties: the author of a legal template is not its approver.
      throw new ConflictError(
        'A template version must be approved by someone other than its author',
        'FR-003',
      );
    }

    const [row] = await this.knex('agreement_template_versions')
      .where('id', versionId)
      .update({ status: 'APPROVED', approved_by: approvedBy, approved_at: new Date() })
      .returning('*');
    return row;
  }

  async retireVersion(versionId: string) {
    const [row] = await this.knex('agreement_template_versions')
      .where('id', versionId)
      .update({ status: 'RETIRED' })
      .returning('*');
    if (!row) throw new NotFoundError('Template version', versionId);
    return row;
  }

  async listTypes() {
    return this.knex('agreement_types').where('is_active', true).orderBy('code');
  }

  async listTemplates(agreementTypeId?: string) {
    return this.knex('agreement_templates')
      .modify((q) => {
        if (agreementTypeId) q.where('agreement_type_id', agreementTypeId);
      })
      .where('is_active', true)
      .orderBy('name');
  }

  async listVersions(templateId: string) {
    return this.knex('agreement_template_versions')
      .where('template_id', templateId)
      .orderBy('version_no', 'desc')
      .select('id', 'version_no', 'status', 'approved_at', 'created_at');
  }

  /** Render a version against sample data, so a drafter sees the merge before approving. */
  async preview(versionId: string, variables: Record<string, unknown>) {
    const version = await this.knex('agreement_template_versions').where('id', versionId).first();
    if (!version) throw new NotFoundError('Template version', versionId);
    const merged = mergeTemplate(version.content, variables);
    const unresolved = [...merged.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
    return { html: merged, unresolved: [...new Set(unresolved)] };
  }

  /**
   * A placeholder that no one supplies renders as literal `{{name}}` in an executed
   * legal document. Catching it at authoring time is far cheaper than at signing.
   */
  private assertPlaceholdersDeclared(
    content: string,
    schema?: { required?: string[] },
  ): void {
    const used = new Set([...content.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]));
    const systemProvided = new Set(['agreementNumber', 'generatedAt']);
    const declared = new Set(schema?.required ?? []);
    const undeclared = [...used].filter((v) => !declared.has(v) && !systemProvided.has(v));

    if (undeclared.length) {
      throw new ValidationError(
        `Template uses variables that are not declared as required: ${undeclared.join(', ')}`,
        { undeclared },
      );
    }
  }
}

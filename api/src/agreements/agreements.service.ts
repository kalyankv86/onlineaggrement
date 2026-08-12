import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX, Db } from '../common/database/database.module';
import { AuditService, AuditEvent } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';
import { DocumentsService } from '../documents/documents.service';
import { StampsService } from '../stamps/stamps.service';
import { StorageDriver } from '../documents/storage/storage.driver';
import { NotFoundError, ValidationError, ConflictError } from '../common/errors/domain.errors';
import { financialYear } from '../common/util/financial-year';
import { Principal } from '../auth/auth.service';
import { Role, availableActions } from '../workflow/state-machine';

export interface CreateAgreementInput {
  agreementTypeId: string;
  templateVersionId?: string;
  placeOfExecutionState?: string;
  data: Record<string, unknown>;
  parties: {
    // ACCOUNTS is added by the service, never by the caller — it signs nothing.
    partyType: 'AGENT' | 'MD' | 'ACCOUNTS';
    userId?: string;
    name: string;
    email: string;
    mobile?: string;
    identityReference?: string;
  }[];
}

@Injectable()
export class AgreementsService {
  private readonly log = new Logger(AgreementsService.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly documents: DocumentsService,
    private readonly stamps: StampsService,
    private readonly storage: StorageDriver,
  ) {}

  /** FR-002 — create in DRAFT. Nothing is generated until stamp and data are settled. */
  async create(input: CreateAgreementInput, actor: Principal, ctx: { ipAddress?: string; userAgent?: string }) {
    const type = await this.knex('agreement_types').where('id', input.agreementTypeId).first();
    if (!type) throw new NotFoundError('Agreement type', input.agreementTypeId);
    if (!type.is_active) throw new ValidationError(`Agreement type ${type.code} is not active`);

    /*
     * DEC-025 — an UPLOAD type carries no template: GTIDS supplies the agreement
     * as its own document. TEMPLATE types keep the FR-003 controls, since there
     * the portal still authors the text being executed.
     */
    let templateVersion: { id: string; variables_schema: { required?: string[] } } | null = null;
    if (type.document_source === 'TEMPLATE') {
      if (!input.templateVersionId) {
        throw new ValidationError(`Agreement type ${type.code} requires a template version`);
      }
      templateVersion = await this.knex('agreement_template_versions')
        .where('id', input.templateVersionId)
        .first();
      if (!templateVersion) throw new NotFoundError('Template version', input.templateVersionId);
      const status = (templateVersion as unknown as { status: string }).status;
      if (status !== 'APPROVED') {
        throw new ValidationError(
          `Template version is ${status}; only APPROVED versions may be used`,
        );
      }
      this.assertTemplateVariables(templateVersion.variables_schema, input.data);
    }

    // DEC-024 — two signing parties. Accounts is added automatically below and is
    // never supplied by the caller, because it signs nothing.
    for (const required of ['AGENT', 'MD'] as const) {
      if (!input.parties.some((p) => p.partyType === required)) {
        throw new ValidationError(`Agreement requires a ${required} party`);
      }
    }

    return this.knex.transaction(async (trx) => {
      const { rows } = await trx.raw('SELECT next_agreement_number(?, ?) AS number', [
        financialYear(),
        type.code,
      ]);
      const agreementNumber: string = rows[0].number;

      const [agreement] = await trx('agreements')
        .insert({
          agreement_number: agreementNumber,
          agreement_type_id: type.id,
          template_version_id: templateVersion?.id ?? null,
          status: 'DRAFT',
          current_version: 1,
          stamp_type: type.requires_stamp ? 'PHYSICAL' : 'NONE',
          place_of_execution_state: input.placeOfExecutionState ?? null,
          party_access_mode: type.party_access_mode,
          data: JSON.stringify(input.data),
          created_by: actor.userId,
        })
        .returning('*');

      const order: Record<string, number> = { AGENT: 1, EMPLOYEE: 2, MD: 3, ACCOUNTS: 9 };

      /*
       * DEC-028 — Accounts receives the completion copy. Recorded as a party on
       * the agreement rather than read from configuration at send time, so the
       * record shows who was notified even if the configured mailbox later changes.
       */
      const parties = [...input.parties];
      if (type.accounts_email && !parties.some((p) => p.partyType === 'ACCOUNTS')) {
        parties.push({
          partyType: 'ACCOUNTS',
          name: 'Accounts',
          email: type.accounts_email,
        });
      }

      await trx('agreement_parties').insert(
        parties.map((p) => ({
          agreement_id: agreement.id,
          party_type: p.partyType,
          user_id: p.userId ?? null,
          name: p.name,
          email: p.email,
          mobile: p.mobile ?? null,
          identity_reference: p.identityReference ?? null,
          signing_order: order[p.partyType] ?? 99,
        })),
      );

      await this.audit.record(
        AuditEvent.AGREEMENT_CREATED,
        {
          agreementNumber,
          agreementType: type.code,
          templateVersionId: templateVersion?.id ?? null,
          parties: input.parties.map((p) => ({ type: p.partyType, email: p.email })),
        },
        { agreementId: agreement.id, agreementVersion: 1, actorId: actor.userId, ...ctx },
        trx,
      );

      return agreement;
    });
  }

  /**
   * Edit a draft — the other half of the correction loop (FR-015a).
   *
   * Without this, a rejected agreement could be re-opened but not actually
   * corrected, and version N+1 would reproduce the document that was rejected.
   * Restricted to DRAFT: once generation has happened the document is the record,
   * and changing the data underneath it would desynchronise the two.
   */
  async updateDraft(
    agreementId: string,
    patch: { data?: Record<string, unknown>; placeOfExecutionState?: string },
    actor: Principal,
    ctx: { ipAddress?: string; userAgent?: string },
  ) {
    const agreement = await this.workflow.get(agreementId);
    if (agreement.status !== 'DRAFT') {
      throw new ConflictError(
        `Agreement content can only be edited while DRAFT (currently ${agreement.status})`,
        'BR-005',
      );
    }

    const merged = { ...agreement.data, ...(patch.data ?? {}) };
    if (patch.data) {
      const templateVersion = await this.knex('agreement_template_versions')
        .where('id', agreement.template_version_id)
        .first();
      this.assertTemplateVariables(templateVersion.variables_schema, merged);
    }

    return this.knex.transaction(async (trx) => {
      const [updated] = await trx('agreements')
        .where('id', agreementId)
        .update({
          data: JSON.stringify(merged),
          ...(patch.placeOfExecutionState
            ? { place_of_execution_state: patch.placeOfExecutionState }
            : {}),
          row_version: agreement.row_version + 1,
          updated_at: new Date(),
        })
        .returning('*');

      await this.audit.record(
        AuditEvent.AGREEMENT_CORRECTED,
        {
          version: agreement.current_version,
          changedKeys: Object.keys(patch.data ?? {}),
        },
        {
          agreementId,
          agreementVersion: agreement.current_version,
          actorId: actor.userId,
          ...ctx,
        },
        trx,
      );

      return updated;
    });
  }

  /** FR-005/FR-006 — attach the stamp before generation. */
  async allocateStamp(agreementId: string, stampId: string, actor: Principal) {
    const agreement = await this.workflow.get(agreementId);
    if (agreement.status !== 'DRAFT') {
      throw new ConflictError(
        `Stamp can only be allocated while the agreement is DRAFT (currently ${agreement.status})`,
        'FR-005',
      );
    }
    return this.stamps.allocate({ stampId, agreementId, actorId: actor.userId });
  }

  /**
   * DEC-025 — attach the agreement GTIDS supplies, compose it with the stamp
   * scan, and move to READY_FOR_AGENT_SIGNATURE.
   *
   * This replaces template generation for UPLOAD types. The document and the
   * state change commit together: an agreement waiting on a signature with no
   * document would strand the Agent, and a document without the state change
   * would be re-composed on retry and orphan the first one.
   */
  async uploadAgreementDocument(
    params: {
      agreementId: string;
      file: Buffer;
      filename: string;
      contentType: string;
      actor: Principal;
    },
    ctx: { ipAddress?: string; userAgent?: string },
  ) {
    const agreement = await this.workflow.get(params.agreementId);
    if (agreement.status !== 'DRAFT') {
      throw new ConflictError(
        `The agreement document can only be attached while the agreement is DRAFT (currently ${agreement.status})`,
        'BR-005',
      );
    }

    const type = await this.knex('agreement_types').where('id', agreement.agreement_type_id).first();
    if (type.requires_stamp) {
      const allocation = await this.knex('stamp_allocations')
        .where({ agreement_id: params.agreementId })
        .whereNull('released_at')
        .first();
      if (!allocation) {
        throw new ValidationError(
          'Allocate the stamp paper first — it becomes page 1 of the executed document',
        );
      }
    }

    const stampScan = await this.loadStampScan(params.agreementId);

    return this.knex.transaction(async (trx) => {
      const composed = await this.documents.composeFromUpload(
        {
          agreementId: agreement.id,
          agreementNumber: agreement.agreement_number,
          version: agreement.current_version,
          uploaded: params.file,
          filename: params.filename,
          contentType: params.contentType,
          stampScan,
        },
        trx,
      );

      await trx('agreement_source_documents')
        .insert({
          agreement_id: agreement.id,
          agreement_version: agreement.current_version,
          original_filename: params.filename,
          original_content_type: params.contentType,
          original_file_key: composed.fileKey,
          original_hash: composed.documentHash,
          page_count: composed.pageCount,
          uploaded_by: params.actor.userId,
        })
        .onConflict(['agreement_id', 'agreement_version'])
        .merge();

      await this.workflow.transition(
        {
          agreementId: agreement.id,
          action: 'GENERATE',
          actorId: params.actor.userId,
          actorRoles: params.actor.roles,
          trigger: 'USER',
          auditEvent: AuditEvent.AGREEMENT_GENERATED,
          auditData: {
            source: 'UPLOAD',
            originalFilename: params.filename,
            convertedFromWord: composed.convertedFromWord,
            pageCount: composed.pageCount,
            documentHash: composed.documentHash,
          },
          auditContext: ctx,
        },
        trx,
      );

      return {
        documentHash: composed.documentHash,
        pageCount: composed.pageCount,
        convertedFromWord: composed.convertedFromWord,
        version: agreement.current_version,
      };
    });
  }

  /**
   * FR-009 — generate version N and move to READY_FOR_AGENT_SIGNATURE.
   *
   * Document generation happens inside the same transaction as the state change:
   * an agreement that is READY_FOR_AGENT_SIGNATURE without a prepared document
   * would strand the Agent, and a prepared document without the state change
   * would be regenerated on retry and orphan the first one.
   */
  async generate(agreementId: string, actor: Principal, ctx: { ipAddress?: string; userAgent?: string }) {
    const agreement = await this.workflow.get(agreementId);
    const type = await this.knex('agreement_types').where('id', agreement.agreement_type_id).first();

    if (type.requires_stamp) {
      const allocation = await this.knex('stamp_allocations')
        .where({ agreement_id: agreementId })
        .whereNull('released_at')
        .first();
      if (!allocation) {
        throw new ValidationError(
          `Agreement type ${type.code} requires a stamp paper to be allocated before generation`,
        );
      }
    }

    const templateVersion = await this.knex('agreement_template_versions')
      .where('id', agreement.template_version_id)
      .first();

    const stampScan = await this.loadStampScan(agreementId);

    return this.knex.transaction(async (trx) => {
      const generated = await this.documents.generate(
        {
          agreementId: agreement.id,
          agreementNumber: agreement.agreement_number,
          version: agreement.current_version,
          templateHtml: templateVersion.content,
          variables: {
            ...agreement.data,
            agreementNumber: agreement.agreement_number,
            generatedAt: new Date().toISOString(),
          },
          stampScan,
        },
        trx,
      );

      await this.workflow.transition(
        {
          agreementId: agreement.id,
          action: 'GENERATE',
          actorId: actor.userId,
          actorRoles: actor.roles,
          trigger: 'USER',
          auditEvent: AuditEvent.AGREEMENT_GENERATED,
          auditData: { documentHash: generated.documentHash, fileKey: generated.fileKey },
          auditContext: ctx,
        },
        trx,
      );

      return {
        documentHash: generated.documentHash,
        fileKey: generated.fileKey,
        version: agreement.current_version,
      };
    });
  }

  async get(agreementId: string, actor: Principal) {
    const agreement = await this.knex('agreements').where('id', agreementId).first();
    if (!agreement) throw new NotFoundError('Agreement', agreementId);

    const [parties, versions, allocation] = await Promise.all([
      this.knex('agreement_parties').where('agreement_id', agreementId).orderBy('signing_order'),
      this.knex('agreement_versions')
        .where('agreement_id', agreementId)
        .orderBy(['version_no', 'created_at']),
      this.knex('stamp_allocations')
        .join('stamp_papers', 'stamp_papers.id', 'stamp_allocations.stamp_paper_id')
        .where('stamp_allocations.agreement_id', agreementId)
        .whereNull('stamp_allocations.released_at')
        .select('stamp_papers.stamp_number', 'stamp_papers.denomination', 'stamp_papers.state_code')
        .first(),
    ]);

    return {
      ...agreement,
      parties,
      versions,
      stamp: allocation ?? null,
      availableActions: availableActions(agreement.status, actor.roles as Role[]),
    };
  }

  async list(filter: { status?: string; agreementTypeId?: string; page?: number; pageSize?: number }) {
    const pageSize = Math.min(filter.pageSize ?? 25, 100);
    const page = Math.max(filter.page ?? 1, 1);

    const query = this.knex('agreements')
      .modify((q) => {
        if (filter.status) q.where('status', filter.status);
        if (filter.agreementTypeId) q.where('agreement_type_id', filter.agreementTypeId);
      });

    const [{ count }] = await query.clone().count<{ count: string }[]>('* as count');
    const rows = await query
      .clone()
      .orderBy('created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select(
        'id',
        'agreement_number',
        'status',
        'current_version',
        'created_at',
        'completed_at',
        'expires_at',
      );

    return { total: Number(count), page, pageSize, items: rows };
  }

  async party(agreementId: string, partyType: 'AGENT' | 'EMPLOYEE' | 'MD', db: Db = this.knex) {
    const row = await db('agreement_parties')
      .where({ agreement_id: agreementId, party_type: partyType })
      .first();
    if (!row) throw new NotFoundError(`${partyType} party for agreement`, agreementId);
    return row;
  }

  /** Short-lived, authorization-checked download URL (SRS §12), always audited. */
  async documentUrl(agreementId: string, actor: Principal, ctx: { ipAddress?: string }) {
    const agreement = await this.workflow.get(agreementId);
    const version = await this.documents.currentVersion(agreementId, agreement.current_version);
    const url = await this.documents.signedUrl(version.file_key);

    await this.audit.record(
      AuditEvent.DOCUMENT_DOWNLOADED,
      { fileKey: version.file_key, documentHash: version.document_hash },
      { agreementId, agreementVersion: agreement.current_version, actorId: actor.userId, ...ctx },
    );

    return { url, documentHash: version.document_hash, signatureState: version.signature_state };
  }

  private async loadStampScan(agreementId: string): Promise<Buffer | undefined> {
    const allocation = await this.knex('stamp_allocations')
      .join('stamp_papers', 'stamp_papers.id', 'stamp_allocations.stamp_paper_id')
      .where('stamp_allocations.agreement_id', agreementId)
      .whereNull('stamp_allocations.released_at')
      .select('stamp_papers.file_key')
      .first();
    if (!allocation) return undefined;
    try {
      return await this.storage.get(allocation.file_key);
    } catch (e) {
      this.log.warn(`stamp scan ${allocation.file_key} unreadable: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Required template variables must be present before a document is produced. */
  private assertTemplateVariables(
    schema: { required?: string[] } | null,
    data: Record<string, unknown>,
  ): void {
    const missing = (schema?.required ?? []).filter(
      (key) => data[key] === undefined || data[key] === null || data[key] === '',
    );
    if (missing.length) {
      throw new ValidationError(`Missing required template variables: ${missing.join(', ')}`, {
        missing,
      });
    }
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX } from '../common/database/database.module';
import { DocumentsService } from '../documents/documents.service';
import { DocumentComposer } from '../documents/pdf/composer';
import { StorageDriver } from '../documents/storage/storage.driver';
import { AuditService, AuditEvent } from '../audit/audit.service';
import { sha256 } from '../common/util/crypto.util';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors/domain.errors';

export interface BankRow {
  id: string;
  code: string;
  name: string;
  contact_email: string | null;
  contact_person: string | null;
  employee_signer_user_id: string | null;
  is_active: boolean;
}

const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;

/**
 * Banks and their agreement documents (DEC-031, DEC-032).
 *
 * The invariants that matter are in the database — case-insensitive uniqueness on
 * code and name, and at most one active document per bank. This service turns
 * those constraint violations into messages an administrator can act on, rather
 * than reimplementing the checks and risking disagreement between the two.
 */
@Injectable()
export class BanksService {
  private readonly log = new Logger(BanksService.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly documents: DocumentsService,
    private readonly composer: DocumentComposer,
    private readonly storage: StorageDriver,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<(BankRow & { agent_count: number; has_active_document: boolean })[]> {
    /*
     * Correlated subqueries rather than joins. Joining both the agents and the
     * documents produces a row per combination, and the agent count then has to
     * be de-duplicated — which is easy to get subtly wrong and reads as if it
     * were counting something else.
     */
    return this.knex('banks as b')
      .select(
        'b.*',
        this.knex.raw(
          '(select count(*) from users u where u.bank_id = b.id)::int as agent_count',
        ),
        this.knex.raw(
          '(exists (select 1 from bank_agreement_documents d where d.bank_id = b.id and d.is_active)) as has_active_document',
        ),
      )
      .orderBy('b.name');
  }

  async get(id: string): Promise<BankRow> {
    const bank = await this.knex('banks').where('id', id).first();
    if (!bank) throw new NotFoundError('Bank', id);
    return bank;
  }

  async create(
    input: { code: string; name: string; contactEmail?: string; contactPerson?: string },
    actorId: string,
  ): Promise<BankRow> {
    try {
      const [bank] = await this.knex('banks')
        .insert({
          code: input.code.trim(),
          name: input.name.trim(),
          contact_email: input.contactEmail?.trim() || null,
          contact_person: input.contactPerson?.trim() || null,
          created_by: actorId,
        })
        .returning('*');

      await this.audit.record(
        AuditEvent.CONFIGURATION_CHANGED,
        { change: 'BANK_CREATED', bankId: bank.id, code: bank.code, name: bank.name },
        { actorId },
      );
      return bank;
    } catch (e) {
      throw this.translate(e, input);
    }
  }

  async update(
    id: string,
    input: {
      name?: string;
      contactEmail?: string;
      contactPerson?: string;
      employeeSignerUserId?: string;
      isActive?: boolean;
    },
    actorId: string,
  ): Promise<BankRow> {
    await this.get(id);

    if (input.employeeSignerUserId) {
      await this.assertEligibleSigner(input.employeeSignerUserId);
    }

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.contactEmail !== undefined) patch.contact_email = input.contactEmail.trim() || null;
    if (input.contactPerson !== undefined) patch.contact_person = input.contactPerson.trim() || null;
    if (input.employeeSignerUserId !== undefined) {
      patch.employee_signer_user_id = input.employeeSignerUserId;
    }
    if (input.isActive !== undefined) patch.is_active = input.isActive;

    try {
      const [bank] = await this.knex('banks').where('id', id).update(patch).returning('*');
      await this.audit.record(
        AuditEvent.CONFIGURATION_CHANGED,
        { change: 'BANK_UPDATED', bankId: id, fields: Object.keys(patch) },
        { actorId },
      );
      return bank;
    } catch (e) {
      throw this.translate(e, input);
    }
  }

  /**
   * The eligibility rule for an employee signer, stated once.
   *
   * A signer must hold the EMPLOYEE role and belong to no bank. The second half
   * matters: a user carrying a `bank_id` is an agent, and designating an agent as
   * the GTIDS countersigner would put both signatures on the same side of the
   * agreement.
   */
  private async assertEligibleSigner(userId: string): Promise<void> {
    const user = await this.knex('users as u')
      .leftJoin('user_roles as ur', 'ur.user_id', 'u.id')
      .leftJoin('roles as r', 'r.id', 'ur.role_id')
      .where('u.id', userId)
      .select('u.id', 'u.full_name', 'u.is_active', 'u.bank_id')
      .select(this.knex.raw(`array_agg(r.code) as roles`))
      .groupBy('u.id')
      .first();

    if (!user) throw new NotFoundError('User', userId);
    if (!user.is_active) {
      throw new ValidationError(`${user.full_name} is deactivated and cannot be a signer`);
    }
    if (user.bank_id) {
      throw new ValidationError(
        `${user.full_name} belongs to a bank and is therefore an agent. The GTIDS countersigner must be internal staff.`,
      );
    }
    if (!(user.roles ?? []).includes('EMPLOYEE')) {
      throw new ValidationError(
        `${user.full_name} does not hold the Employee role. Grant it before designating them as a signer.`,
      );
    }
  }

  /** Internal staff who may be designated as a bank's countersigner. */
  async eligibleSigners(): Promise<{ id: string; full_name: string; email: string }[]> {
    return this.knex('users as u')
      .join('user_roles as ur', 'ur.user_id', 'u.id')
      .join('roles as r', 'r.id', 'ur.role_id')
      .where({ 'r.code': 'EMPLOYEE', 'u.is_active': true })
      .whereNull('u.bank_id')
      .select('u.id', 'u.full_name', 'u.email')
      .orderBy('u.full_name');
  }

  /** Named for the rows it returns; `documents` is the injected service. */
  async documentVersions(bankId: string) {
    await this.get(bankId);
    return this.knex('bank_agreement_documents')
      .where('bank_id', bankId)
      .orderBy('version_no', 'desc');
  }

  /**
   * Upload a new version of a bank's agreement and make it the active one.
   *
   * Converted to PDF on upload rather than at execution time. A conversion that
   * is going to mangle the layout should fail here, where an administrator can
   * look at the result and re-export it — not when an agent is mid-ceremony.
   */
  async uploadDocument(
    bankId: string,
    file: { buffer: Buffer; filename: string; contentType: string },
    actorId: string,
  ) {
    const bank = await this.get(bankId);

    if (file.buffer.length === 0) throw new ValidationError('The document is empty');
    if (file.buffer.length > MAX_DOCUMENT_BYTES) {
      throw new ValidationError(
        `The document exceeds the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit`,
      );
    }

    const convertedPdf = await this.composer.toPdf(file.buffer, file.filename, file.contentType);

    /*
     * Count the pages now, so the administrator sees what the conversion actually
     * produced. A Word file that converts to one page when it should be four is
     * the failure worth catching here rather than at execution.
     */
    const { PDFDocument } = await import('pdf-lib');
    const pageCount = (await PDFDocument.load(convertedPdf, { updateMetadata: false })).getPageCount();

    return this.knex.transaction(async (trx) => {
      const [{ next }] = await trx('bank_agreement_documents')
        .where('bank_id', bankId)
        .select(trx.raw('coalesce(max(version_no), 0) + 1 as next'));

      const originalKey = `banks/${bankId}/v${next}-as-supplied`;
      const convertedKey = `banks/${bankId}/v${next}-agreement.pdf`;
      await this.storage.put(originalKey, file.buffer, file.contentType);
      await this.storage.put(convertedKey, convertedPdf, 'application/pdf');

      // Deactivate the previous version first: the partial unique index permits
      // only one active row per bank, so both cannot be active even briefly.
      await trx('bank_agreement_documents')
        .where({ bank_id: bankId, is_active: true })
        .update({ is_active: false });

      const [doc] = await trx('bank_agreement_documents')
        .insert({
          bank_id: bankId,
          version_no: next,
          original_filename: file.filename,
          original_content_type: file.contentType,
          file_key: originalKey,
          file_hash: sha256(file.buffer),
          converted_file_key: convertedKey,
          converted_hash: sha256(convertedPdf),
          page_count: pageCount,
          is_active: true,
          activated_at: new Date(),
          uploaded_by: actorId,
        })
        .returning('*');

      await this.audit.record(
        AuditEvent.CONFIGURATION_CHANGED,
        {
          change: 'BANK_DOCUMENT_UPLOADED',
          bankId,
          bankName: bank.name,
          versionNo: next,
          hash: doc.converted_hash,
          pageCount,
        },
        { actorId },
        trx,
      );

      this.log.log(
        `bank ${bank.code} agreement v${next} activated — ${pageCount} pages, ${doc.converted_hash.slice(0, 16)}…`,
      );
      return doc;
    });
  }

  /** The active document for a bank, which is what an agreement is composed from. */
  async activeDocument(bankId: string) {
    const doc = await this.knex('bank_agreement_documents')
      .where({ bank_id: bankId, is_active: true })
      .first();
    if (!doc) {
      const bank = await this.get(bankId);
      throw new ValidationError(
        `No agreement document is active for ${bank.name}. An administrator must upload one before agreements can be created for this bank.`,
      );
    }
    return doc;
  }

  /**
   * Turn a constraint violation into something an administrator can act on.
   *
   * The database owns these rules, so the message has to be derived from the
   * constraint that fired rather than from a duplicate check in this service that
   * could disagree with it.
   */
  private translate(e: unknown, input: { code?: string; name?: string }): Error {
    const constraint = (e as { constraint?: string }).constraint;
    if (constraint === 'uq_banks_code_ci') {
      return new ConflictError(
        `A bank with the code ${input.code} already exists. Codes are compared ignoring case.`,
        'DEC-031',
      );
    }
    if (constraint === 'uq_banks_name_ci') {
      return new ConflictError(
        `A bank named ${input.name} already exists. Names are compared ignoring case, so this would split one institution's agents across two records.`,
        'DEC-031',
      );
    }
    return e as Error;
  }
}

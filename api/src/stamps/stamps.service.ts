import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX, Db } from '../common/database/database.module';
import { AuditService, AuditEvent } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors/domain.errors';

export interface RegisterStampInput {
  stampNumber?: string;
  /**
   * Every identifier printed on the paper. Each is independently unique
   * (migration 014), so recording all of them means getting any single one right
   * is enough to catch a stamp that has already been registered.
   */
  identifiers?: { kind: 'CERTIFICATE_NO' | 'UNIQUE_DOC_REF' | 'PAPER_SERIAL' | 'OTHER'; value: string }[];
  denomination: number;
  stateCode: string;
  issueDate?: string;
  vendor?: string;
  issuer?: string;
  accountReference?: string;
  ddoCode?: string;
  documentDescription?: string;
  propertyDescription?: string;
  considerationPrice?: number;
  firstParty?: string;
  secondParty?: string;
  scan: Buffer;
  scanContentType: string;
}

/** Uppercase alphanumerics — the form uniqueness is enforced on. */
const normalize = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Physical stamp inventory (FR-005, FR-006, BR-006).
 *
 * The exclusivity guarantee is the partial unique index
 * `uq_stamp_active_allocation` from migration 005, not the checks in this file.
 * Those checks exist to produce a good error message; the index is what makes
 * double-allocation impossible under concurrency (AC-11).
 */
@Injectable()
export class StampsService {
  private readonly log = new Logger(StampsService.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  async register(input: RegisterStampInput, actorId: string): Promise<{ id: string; documentHash: string }> {
    if (input.denomination <= 0) throw new ValidationError('Stamp denomination must be positive');
    if (!input.scan?.length) throw new ValidationError('Stamp scan is required');

    const stored = await this.documents.storeStampScan(input.scan, input.scanContentType);

    // Assemble the identifier set, with the primary number included even if the
    // caller did not list it separately.
    const identifiers = [...(input.identifiers ?? [])];
    if (input.stampNumber && !identifiers.some((i) => normalize(i.value) === normalize(input.stampNumber!))) {
      identifiers.unshift({ kind: 'CERTIFICATE_NO', value: input.stampNumber });
    }
    const usable = identifiers.filter((i) => normalize(i.value).length >= 6);
    if (usable.length === 0) {
      throw new ValidationError(
        'At least one identifier of six characters or more is required — the certificate number, the unique document reference, or the paper serial',
      );
    }

    /*
     * Report a duplicate against the identifier the operator actually entered,
     * naming the existing stamp. A bare unique-violation would say only that
     * something collided, leaving them to work out which of three numbers and
     * which existing record.
     */
    const clashes = await this.knex('stamp_identifiers')
      .join('stamp_papers', 'stamp_papers.id', 'stamp_identifiers.stamp_paper_id')
      .whereIn('stamp_identifiers.normalized', usable.map((i) => normalize(i.value)))
      .select(
        'stamp_identifiers.normalized',
        'stamp_identifiers.value',
        'stamp_identifiers.kind',
        'stamp_papers.id as stamp_id',
        'stamp_papers.status',
      );
    if (clashes.length > 0) {
      const c = clashes[0];
      throw new ConflictError(
        `${c.value} is already registered as the ${String(c.kind).replace(/_/g, ' ').toLowerCase()} of an existing stamp, currently ${c.status}. The same physical stamp cannot be registered twice.`,
        'BR-006',
        { existingStampId: c.stamp_id, matchedOn: c.kind, value: c.value },
      );
    }

    return this.knex.transaction(async (trx) => {
      const [row] = await trx('stamp_papers')
        .insert({
          stamp_number: input.stampNumber ?? null,
          denomination: input.denomination,
          state_code: input.stateCode,
          issue_date: input.issueDate ?? null,
          vendor: input.vendor ?? null,
          file_key: stored.fileKey,
          document_hash: stored.documentHash,
          status: 'AVAILABLE',
          issuer: input.issuer ?? null,
          account_reference: input.accountReference ?? null,
          ddo_code: input.ddoCode ?? null,
          document_description: input.documentDescription ?? null,
          property_description: input.propertyDescription ?? null,
          consideration_price: input.considerationPrice ?? null,
          first_party: input.firstParty ?? null,
          second_party: input.secondParty ?? null,
          created_by: actorId,
        })
        .returning('id')
        .catch((e: Error & { code?: string }) => {
          if (e.code === '23505') {
            throw new ConflictError(
              `Stamp number ${input.stampNumber} is already registered`,
              'FR-006',
            );
          }
          throw e;
        });

      try {
        await trx('stamp_identifiers').insert(
          usable.map((i) => ({
            stamp_paper_id: row.id,
            kind: i.kind,
            value: i.value.trim(),
            normalized: normalize(i.value),
          })),
        );
      } catch (e) {
        // The pre-check above races: two operators registering the same stamp at
        // once both pass it. The index is what actually decides.
        if ((e as { code?: string }).code === '23505') {
          throw new ConflictError(
            'One of these identifiers was registered by someone else a moment ago',
            'BR-006',
          );
        }
        throw e;
      }

      await this.audit.record(
        AuditEvent.STAMP_UPLOADED,
        {
          stampId: row.id,
          stampNumber: input.stampNumber,
          denomination: input.denomination,
          stateCode: input.stateCode,
          documentHash: stored.documentHash,
          identifiers: usable.map((i) => ({ kind: i.kind, value: i.value })),
        },
        { actorId },
        trx,
      );

      return { id: row.id, documentHash: stored.documentHash };
    });
  }

  /**
   * Allocate a stamp to an agreement.
   *
   * Locks the stamp row first so concurrent callers queue rather than race, then
   * lets the partial unique index arbitrate. Both are needed: the lock makes the
   * common path give a clean error, the index makes the guarantee absolute.
   */
  async allocate(
    params: { stampId: string; agreementId: string; actorId: string },
    db?: Db,
  ): Promise<{ allocationId: string }> {
    const run = async (trx: Knex.Transaction) => {
      const stamp = await trx('stamp_papers').where('id', params.stampId).forUpdate().first();
      if (!stamp) throw new NotFoundError('Stamp paper', params.stampId);

      if (stamp.status !== 'AVAILABLE') {
        throw new ConflictError(
          `Stamp ${stamp.stamp_number ?? stamp.id} is ${stamp.status}, not AVAILABLE`,
          'BR-006',
          { stampId: stamp.id, status: stamp.status },
        );
      }

      let allocationId: string;
      try {
        const [allocation] = await trx('stamp_allocations')
          .insert({
            stamp_paper_id: params.stampId,
            agreement_id: params.agreementId,
            allocated_by: params.actorId,
          })
          .returning('id');
        allocationId = allocation.id;
      } catch (e) {
        const err = e as Error & { code?: string; constraint?: string };
        if (err.code === '23505') {
          // The index caught what the status check could not: another transaction
          // committed an allocation between our read and our insert.
          throw new ConflictError(
            err.constraint === 'uq_agreement_active_allocation'
              ? 'This agreement already holds an allocated stamp'
              : 'Stamp was allocated to another agreement concurrently',
            'BR-006',
            { stampId: params.stampId, constraint: err.constraint },
          );
        }
        throw e;
      }

      await trx('stamp_papers').where('id', params.stampId).update({ status: 'ALLOCATED' });

      await this.audit.record(
        AuditEvent.STAMP_ALLOCATED,
        { stampId: params.stampId, stampNumber: stamp.stamp_number, allocationId },
        { agreementId: params.agreementId, actorId: params.actorId },
        trx,
      );

      return { allocationId };
    };

    return db && 'commit' in db
      ? run(db as Knex.Transaction)
      : this.knex.transaction((trx) => run(trx));
  }

  /**
   * Mark the stamp consumed at completion. BR-006 forbids reuse across *completed*
   * agreements, so USED is terminal for the stamp.
   */
  async markUsed(agreementId: string, actorId: string | null, db: Db): Promise<void> {
    const allocation = await db('stamp_allocations')
      .where({ agreement_id: agreementId })
      .whereNull('released_at')
      .first();
    if (!allocation) return; // agreement type may not require a stamp

    await db('stamp_papers').where('id', allocation.stamp_paper_id).update({ status: 'USED' });
    await this.audit.record(
      AuditEvent.STAMP_MARKED_USED,
      { stampId: allocation.stamp_paper_id, allocationId: allocation.id },
      { agreementId, actorId },
      db,
    );
  }

  /**
   * Release on cancellation only. Deliberately NOT called on rejection or expiry:
   * a correction cycle is the same transaction and keeps its stamp (DEC-007 /
   * FR-015b).
   */
  async release(
    params: { agreementId: string; reason: string; actorId: string | null },
    db: Db,
  ): Promise<void> {
    const allocation = await db('stamp_allocations')
      .where({ agreement_id: params.agreementId })
      .whereNull('released_at')
      .first();
    if (!allocation) return;

    await db('stamp_allocations')
      .where('id', allocation.id)
      .update({ released_at: new Date(), released_reason: params.reason });
    await db('stamp_papers').where('id', allocation.stamp_paper_id).update({ status: 'AVAILABLE' });

    await this.audit.record(
      AuditEvent.STAMP_RELEASED,
      { stampId: allocation.stamp_paper_id, reason: params.reason },
      { agreementId: params.agreementId, actorId: params.actorId },
      db,
    );
  }

  async findAvailable(denomination: number, stateCode?: string): Promise<unknown[]> {
    return this.knex('stamp_papers')
      .where({ status: 'AVAILABLE', denomination })
      .modify((q) => {
        if (stateCode) q.where('state_code', stateCode);
      })
      .orderBy('created_at', 'asc')
      .select('id', 'stamp_number', 'denomination', 'state_code', 'issue_date', 'vendor');
  }

  async get(stampId: string): Promise<unknown> {
    const row = await this.knex('stamp_papers').where('id', stampId).first();
    if (!row) throw new NotFoundError('Stamp paper', stampId);
    return row;
  }

  /** FR-020 — stamp inventory report. */
  async inventoryReport(): Promise<unknown> {
    const byStatus = await this.knex('stamp_papers')
      .select('status', 'state_code')
      .count('* as count')
      .sum('denomination as value')
      .groupBy('status', 'state_code');
    return { byStatus };
  }
}

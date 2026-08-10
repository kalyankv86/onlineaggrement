import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX, Db } from '../common/database/database.module';
import { EsignProvider, ProviderStatus, VerifiedCallback } from './provider.interface';
import { ConflictError, NotFoundError } from '../common/errors/domain.errors';
import { AuditService, AuditEvent } from '../audit/audit.service';

export interface EsignTransactionRow {
  id: string;
  agreement_id: string;
  party_id: string;
  agreement_version: number;
  provider: string;
  provider_transaction_id: string;
  byte_range_digest: string | null;
  document_hash: string;
  /** Object key of the half-signed document parked between ceremony phases. */
  pending_file_key: string | null;
  status: ProviderStatus['status'];
  attempt_no: number;
  failure_code: string | null;
}

export type CallbackOutcome = 'APPLIED' | 'DUPLICATE' | 'REJECTED_SIGNATURE' | 'UNMATCHED' | 'STALE';

export interface CallbackResult {
  outcome: CallbackOutcome;
  transaction?: EsignTransactionRow;
  event?: VerifiedCallback;
  reason?: string;
}

/**
 * Signing transaction lifecycle and the callback ledger.
 *
 * Knows nothing about documents or workflow states — that orchestration lives in
 * SigningService. This separation is what keeps the provider adapter from leaking
 * into the agreement engine (SDD §20).
 */
@Injectable()
export class EsignService {
  private readonly log = new Logger(EsignService.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly provider: EsignProvider,
    private readonly audit: AuditService,
  ) {}

  capabilities() {
    return this.provider.capabilities();
  }

  async createTransaction(
    params: {
      agreementId: string;
      agreementNumber: string;
      partyId: string;
      agreementVersion: number;
      signer: { name: string; email: string; mobile?: string; identityReference?: string };
      byteRangeDigest: string;
      documentHash: string;
      reason: string;
      location: string;
      callbackUrl: string;
    },
    db: Db = this.knex,
  ): Promise<{ transaction: EsignTransactionRow; ceremonyUrl: string }> {
    const caps = this.provider.capabilities();

    const previous = await db('esign_transactions')
      .where({
        agreement_id: params.agreementId,
        party_id: params.partyId,
        agreement_version: params.agreementVersion,
      })
      .orderBy('attempt_no', 'desc')
      .first();

    const result = await this.provider.initiateSigning({
      agreementId: params.agreementId,
      agreementNumber: params.agreementNumber,
      partyId: params.partyId,
      signer: params.signer,
      // HASH mode: only the digest leaves GTIDS. The document is never sent.
      byteRangeDigest: caps.mode === 'HASH' ? params.byteRangeDigest : undefined,
      reason: params.reason,
      location: params.location,
      callbackUrl: params.callbackUrl,
    });

    let rows: EsignTransactionRow[];
    try {
      rows = await db('esign_transactions')
        .insert({
          agreement_id: params.agreementId,
          party_id: params.partyId,
          agreement_version: params.agreementVersion,
          provider: caps.name,
          provider_transaction_id: result.providerTransactionId,
          byte_range_digest: params.byteRangeDigest,
          document_hash: params.documentHash,
          status: 'PENDING_SIGNER',
          attempt_no: (previous?.attempt_no ?? 0) + 1,
          expires_at: result.expiresAt,
        })
        .returning('*');
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === '23505') {
        // uq_esign_open_per_party — a signing ceremony is already in flight.
        throw new ConflictError(
          'A signing transaction is already open for this signer on this version',
          'FR-014',
          { agreementId: params.agreementId, partyId: params.partyId },
        );
      }
      throw e;
    }

    return { transaction: rows[0], ceremonyUrl: result.ceremonyUrl };
  }

  /**
   * Ingest a provider callback — DEC-010 / FR-023 / AC-13.
   *
   * Order matters: authenticate first, then claim the event id, then apply. The
   * unique index on (provider, provider_event_id) is the idempotency mechanism;
   * a duplicate loses the insert race and is acknowledged without effect.
   */
  async ingestCallback(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<CallbackResult> {
    const caps = this.provider.capabilities();
    const verification = this.provider.verifyCallback(rawBody, headers);

    if (!verification.valid || !verification.event) {
      // Recorded even though it is rejected: a stream of failing signatures is
      // exactly what a security reviewer needs to see.
      await this.knex('esign_callback_events')
        .insert({
          provider: caps.name,
          provider_event_id: `unverified-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          raw_payload: JSON.stringify({ reason: verification.reason }),
          signature_valid: false,
          processed_at: new Date(),
          outcome: 'REJECTED_SIGNATURE',
        })
        .catch(() => undefined);
      this.log.warn(`rejected provider callback: ${verification.reason}`);
      return { outcome: 'REJECTED_SIGNATURE', reason: verification.reason };
    }

    const event = verification.event;

    try {
      await this.knex('esign_callback_events').insert({
        provider: caps.name,
        provider_event_id: event.providerEventId,
        raw_payload: JSON.stringify(event.payload),
        signature_valid: true,
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        this.log.log(`duplicate callback ${event.providerEventId} ignored`);
        return { outcome: 'DUPLICATE', event };
      }
      throw e;
    }

    const transaction = await this.knex('esign_transactions')
      .where({ provider: caps.name, provider_transaction_id: event.providerTransactionId })
      .first();

    if (!transaction) {
      await this.finishEvent(event.providerEventId, caps.name, null, 'UNMATCHED');
      this.log.warn(`callback for unknown transaction ${event.providerTransactionId}`);
      return { outcome: 'UNMATCHED', event };
    }

    // Late callback for a transaction already resolved — accepted, not applied.
    if (['SIGNED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(transaction.status)) {
      await this.finishEvent(event.providerEventId, caps.name, transaction.id, 'STALE');
      return { outcome: 'STALE', transaction, event };
    }

    await this.finishEvent(event.providerEventId, caps.name, transaction.id, 'APPLIED');
    return { outcome: 'APPLIED', transaction, event };
  }

  private async finishEvent(
    providerEventId: string,
    provider: string,
    transactionId: string | null,
    outcome: CallbackOutcome,
  ): Promise<void> {
    await this.knex('esign_callback_events')
      .where({ provider, provider_event_id: providerEventId })
      .update({ esign_transaction_id: transactionId, processed_at: new Date(), outcome });
  }

  async getSignature(providerTransactionId: string): Promise<Buffer> {
    return this.provider.getSignature(providerTransactionId);
  }

  async getProviderStatus(providerTransactionId: string): Promise<ProviderStatus> {
    return this.provider.getStatus(providerTransactionId);
  }

  async getTransaction(id: string, db: Db = this.knex): Promise<EsignTransactionRow> {
    const row = await db('esign_transactions').where('id', id).first();
    if (!row) throw new NotFoundError('eSign transaction', id);
    return row;
  }

  async markSigned(
    transactionId: string,
    details: { signerCertSubject?: string; signerCertSerial?: string },
    db: Db = this.knex,
  ): Promise<void> {
    await db('esign_transactions').where('id', transactionId).update({
      status: 'SIGNED',
      completed_at: new Date(),
      signer_cert_subject: details.signerCertSubject ?? null,
      signer_cert_serial: details.signerCertSerial ?? null,
      updated_at: new Date(),
    });
  }

  async markFailed(
    transactionId: string,
    failureCode: string,
    status: 'FAILED' | 'EXPIRED' | 'CANCELLED' = 'FAILED',
    db: Db = this.knex,
  ): Promise<void> {
    await db('esign_transactions')
      .where('id', transactionId)
      .update({ status, failure_code: failureCode, completed_at: new Date(), updated_at: new Date() });
  }

  /** FR-024 — transactions still in flight, for the reconciliation job. */
  async openTransactions(olderThanSeconds = 60): Promise<EsignTransactionRow[]> {
    return this.knex('esign_transactions')
      .whereIn('status', ['INITIATED', 'PENDING_SIGNER'])
      .where('initiated_at', '<', new Date(Date.now() - olderThanSeconds * 1000))
      .select('*');
  }

  async recordIntegrityAlert(
    agreementId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(AuditEvent.SIGNATURE_INTEGRITY_ALERT, details, { agreementId });
    this.log.error(`SIGNATURE INTEGRITY ALERT on agreement ${agreementId}: ${JSON.stringify(details)}`);
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import { KNEX } from '../common/database/database.module';
import { WorkflowService } from '../workflow/workflow.service';
import { DocumentsService } from '../documents/documents.service';
import { EsignService } from '../esign/esign.service';
import { StampsService } from '../stamps/stamps.service';
import { AgreementsService } from '../agreements/agreements.service';
import {
  NotificationsService,
  type NotificationEvent,
  type PartyType,
} from '../notifications/notifications.service';
import { AuditService, AuditEvent } from '../audit/audit.service';

/** AuditEvent is a const object, so its values need extracting as a type. */
type AuditEventName = (typeof AuditEvent)[keyof typeof AuditEvent];
import { Principal } from '../auth/auth.service';
import {
  ConflictError,
  ForbiddenError,
  StaleDocumentError,
  SignatureIntegrityError,
  ValidationError,
} from '../common/errors/domain.errors';
import { generateVerificationToken } from '../common/util/crypto.util';
import type { AgreementState, WorkflowAction } from '../workflow/state-machine';

export interface ActionContext {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Orchestrates the mandated sequence: Agent signs -> MD signs -> COMPLETED
 * (SRS §3 as amended by DEC-024; the Employee approval step was removed).
 *
 * Sequencing itself is not enforced here — it is structural in the transition
 * table (state-machine.ts). What this service owns is the coupling between a state
 * change and its document effect, so the two can never disagree.
 */
/**
 * Everything that differs between the three signing parties, in one place.
 *
 * This was previously expressed as `party === 'AGENT' ? … : …` at six separate
 * points. That shape is safe with two parties and quietly wrong with three: every
 * one of those expressions would have treated the employee as the MD — embedding
 * their signature in the MD's widget, auditing it as MD_SIGNED and completing the
 * agreement one signature early. None of it would have thrown.
 *
 * `advance` is the edge taken once the signature succeeds; null means this
 * signature completes the agreement.
 */
interface SigningPartySpec {
  initiate: WorkflowAction;
  succeed: WorkflowAction;
  fail: WorkflowAction;
  signingState: AgreementState;
  advance: WorkflowAction | null;
  initiatedEvent: AuditEventName;
  signedEvent: AuditEventName;
  /** Appears in the PDF signature's /Reason. */
  reason: string;
  /** Signatures already on the document when this party signs. */
  signaturesBefore: number;
  /** Who is told once this signature lands. */
  notifyOnSigned: { eventType: NotificationEvent; recipients: PartyType[] } | null;
}

export type SigningParty = 'AGENT' | 'EMPLOYEE' | 'MD';

const SIGNING_PARTY: Record<SigningParty, SigningPartySpec> = {
  AGENT: {
    initiate: 'AGENT_SIGN_INITIATE',
    succeed: 'AGENT_SIGN_SUCCEED',
    fail: 'AGENT_SIGN_FAIL',
    signingState: 'AGENT_SIGNING',
    advance: 'ADVANCE_TO_EMPLOYEE',
    initiatedEvent: AuditEvent.AGENT_SIGN_INITIATED,
    signedEvent: AuditEvent.AGENT_SIGNED,
    reason: 'Agent execution',
    signaturesBefore: 0,
    notifyOnSigned: { eventType: 'AGENT_SIGNED', recipients: ['EMPLOYEE'] },
  },
  EMPLOYEE: {
    initiate: 'EMPLOYEE_SIGN_INITIATE',
    succeed: 'EMPLOYEE_SIGN_SUCCEED',
    fail: 'EMPLOYEE_SIGN_FAIL',
    signingState: 'EMPLOYEE_SIGNING',
    advance: 'ADVANCE_TO_MD',
    initiatedEvent: AuditEvent.EMPLOYEE_SIGN_INITIATED,
    signedEvent: AuditEvent.EMPLOYEE_SIGNED,
    reason: 'Verified and executed on behalf of GTIDS',
    signaturesBefore: 1,
    notifyOnSigned: { eventType: 'EMPLOYEE_SIGNED', recipients: ['MD'] },
  },
  MD: {
    initiate: 'MD_SIGN_INITIATE',
    succeed: 'MD_SIGN_SUCCEED',
    fail: 'MD_SIGN_FAIL',
    signingState: 'MD_SIGNING',
    advance: null, // completes the agreement
    initiatedEvent: AuditEvent.MD_SIGN_INITIATED,
    signedEvent: AuditEvent.MD_SIGNED,
    reason: 'Final execution on behalf of GTIDS',
    signaturesBefore: 2,
    notifyOnSigned: null, // completion notifies everyone, in finalize()
  },
};

@Injectable()
export class SigningService {
  private readonly log = new Logger(SigningService.name);
  private readonly callbackUrl: string;

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly workflow: WorkflowService,
    private readonly documents: DocumentsService,
    private readonly esign: EsignService,
    private readonly stamps: StampsService,
    private readonly agreements: AgreementsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.callbackUrl = `${config.get<string>('apiBaseUrl')}/api/v1/esign/callback`;
  }

  // ── Agent and MD signature (FR-011, FR-013) ─────────────────────────────────

  /**
   * Phase 1: reserve the signature slot, register the transaction with the ESP,
   * and hand back the ceremony URL. Nothing is signed yet.
   */
  async initiateSignature(
    params: {
      agreementId: string;
      party: SigningParty;
      presentedDocumentHash: string;
      actor: Principal;
    },
    ctx: ActionContext = {},
  ): Promise<{ transactionId: string; ceremonyUrl: string; byteRangeDigest: string }> {
    const agreement = await this.workflow.get(params.agreementId);
    const version = await this.documents.currentVersion(agreement.id, agreement.current_version);

    // FR-027 — refuse to sign a document other than the one the actor was shown.
    if (version.document_hash !== params.presentedDocumentHash) {
      throw new StaleDocumentError(params.presentedDocumentHash, version.document_hash);
    }

    const party = await this.agreements.party(agreement.id, params.party);
    this.assertActorIsParty(params.actor, party);

    // The state change happens first: an open ceremony must be visible to everyone
    // else immediately, so a second signer cannot start a parallel one.
    const spec = SIGNING_PARTY[params.party];

    await this.workflow.transition({
      agreementId: agreement.id,
      action: spec.initiate,
      actorId: params.actor.userId,
      actorRoles: params.actor.roles,
      trigger: 'USER',
      auditEvent: spec.initiatedEvent,
      auditData: { documentHash: version.document_hash },
      auditContext: ctx,
    });

    const prepared = await this.documents.beginSignature({
      agreementNumber: agreement.agreement_number,
      version: agreement.current_version,
      sourceFileKey: version.file_key,
      field: params.party,
      signerName: party.name,
      reason: `${spec.reason} of ${agreement.agreement_number}`,
      location: agreement.data?.placeOfExecution
        ? String(agreement.data.placeOfExecution)
        : 'India',
    });

    const { transaction, ceremonyUrl } = await this.esign.createTransaction({
      agreementId: agreement.id,
      agreementNumber: agreement.agreement_number,
      partyId: party.id,
      agreementVersion: agreement.current_version,
      signer: {
        name: party.name,
        email: party.email,
        mobile: party.mobile,
        identityReference: party.identity_reference,
      },
      byteRangeDigest: prepared.byteRangeDigest,
      documentHash: version.document_hash,
      reason: `Execution of ${agreement.agreement_number}`,
      location: 'India',
      callbackUrl: this.callbackUrl,
    });

    await this.knex('signature_events').insert({
      agreement_id: agreement.id,
      party_id: party.id,
      agreement_version: agreement.current_version,
      event_type: 'SIGN_INITIATED',
      document_hash: version.document_hash,
      esign_transaction_id: transaction.id,
      ip_address: ctx.ipAddress ?? null,
      user_agent: ctx.userAgent ?? null,
    });

    // The parked bytes are addressed by the transaction so the callback — which
    // may land on another instance — can find them.
    await this.knex('esign_transactions')
      .where('id', transaction.id)
      .update({ pending_file_key: prepared.pendingFileKey });

    return {
      transactionId: transaction.id,
      ceremonyUrl,
      byteRangeDigest: prepared.byteRangeDigest,
    };
  }

  /**
   * Phase 2: the ESP reports the ceremony finished. Fetch the PKCS#7, embed it,
   * verify every signature, and advance the workflow — all in one transaction.
   */
  async completeSignature(transactionId: string, ctx: ActionContext = {}): Promise<void> {
    const transaction = await this.esign.getTransaction(transactionId);
    const agreement = await this.workflow.get(transaction.agreement_id);
    const party = await this.knex('agreement_parties').where('id', transaction.party_id).first();
    /*
     * Read the party type straight through rather than mapping anything not-AGENT
     * onto MD. An unrecognised value must stop the callback, not be absorbed into
     * the MD's widget.
     */
    const field = party.party_type as SigningParty;
    const spec = SIGNING_PARTY[field];
    if (!spec) {
      throw new ValidationError(
        `Party type ${party.party_type} is not a signing party`,
      );
    }

    const providerStatus = await this.esign.getProviderStatus(transaction.provider_transaction_id);
    if (providerStatus.status !== 'SIGNED') {
      await this.failSignature(
        transactionId,
        providerStatus.failureCode ?? 'PROVIDER_REPORTED_NOT_SIGNED',
        ctx,
      );
      return;
    }

    const der = await this.esign.getSignature(transaction.provider_transaction_id);

    const signaturesBefore = spec.signaturesBefore;

    let result;
    try {
      result = await this.knex.transaction(async (trx) => {
        const stored = await this.documents.completeSignature(
          {
            agreementId: agreement.id,
            agreementNumber: agreement.agreement_number,
            version: agreement.current_version,
            pendingFileKey: transaction.pending_file_key!,
            field,
            der,
            expectedDigest: transaction.byte_range_digest!,
            signaturesBefore,
          },
          trx,
        );

        await this.esign.markSigned(
          transactionId,
          {
            signerCertSubject: providerStatus.signerCertSubject,
            signerCertSerial: providerStatus.signerCertSerial,
          },
          trx,
        );

        await trx('signature_events').insert({
          agreement_id: agreement.id,
          party_id: party.id,
          agreement_version: agreement.current_version,
          event_type: 'SIGNED',
          document_hash: stored.documentHash,
          esign_transaction_id: transactionId,
          ip_address: ctx.ipAddress ?? null,
          user_agent: ctx.userAgent ?? null,
        });

        await trx('agreement_parties').where('id', party.id).update({ status: 'ACTED' });

        if (spec.advance) {
          /*
           * The signature succeeding and the agreement moving to the next signer
           * are one consequence, not two decisions — they commit together, so an
           * agreement can never be left signed but waiting on nobody.
           */
          await this.workflow.transitionChain(
            [
              {
                agreementId: agreement.id,
                action: spec.succeed,
                actorId: party.user_id ?? null,
                actorRoles: ['SYSTEM'],
                trigger: 'PROVIDER_CALLBACK',
                auditEvent: spec.signedEvent,
                auditData: { documentHash: stored.documentHash, transactionId },
              },
              {
                agreementId: agreement.id,
                action: spec.advance,
                actorId: null,
                actorRoles: ['SYSTEM'],
                trigger: 'SYSTEM',
              },
            ],
            trx,
          );
          if (spec.notifyOnSigned) {
            await this.notifications.enqueue(
              {
                agreementId: agreement.id,
                eventType: spec.notifyOnSigned.eventType,
                recipients: spec.notifyOnSigned.recipients,
              },
              trx,
            );
          }
        } else {
          // The last signature. Completion mints the public verification token.
          await this.workflow.transition(
            {
              agreementId: agreement.id,
              action: spec.succeed,
              actorId: party.user_id ?? null,
              actorRoles: ['SYSTEM'],
              trigger: 'PROVIDER_CALLBACK',
              auditEvent: spec.signedEvent,
              auditData: { documentHash: stored.documentHash, transactionId },
              patch: {
                completed_at: new Date(),
                verification_token: generateVerificationToken(),
                expires_at: null,
              },
            },
            trx,
          );
          await this.finalize(agreement.id, stored.documentHash, trx);
        }

        return stored;
      });
    } catch (e) {
      if (e instanceof SignatureIntegrityError) {
        // A prior signature stopped verifying. Never silently retried: the
        // document is not persisted, the agreement stops, and a security alert
        // is raised (SRS v1.1 §8.3).
        await this.esign.recordIntegrityAlert(agreement.id, {
          transactionId,
          field,
          detail: e.message,
          ...(e.details ?? {}),
        });
        await this.failSignature(transactionId, 'SIGNATURE_INTEGRITY_FAILURE', ctx);
        return;
      }
      throw e;
    }

    this.log.log(
      `${agreement.agreement_number}: ${field} signature applied, ${result.report.count} signature(s) valid`,
    );
  }

  /** Provider reported failure, or the ceremony expired (FR-011, max attempts). */
  async failSignature(transactionId: string, failureCode: string, ctx: ActionContext = {}): Promise<void> {
    const transaction = await this.esign.getTransaction(transactionId);
    const agreement = await this.workflow.get(transaction.agreement_id);
    const party = await this.knex('agreement_parties').where('id', transaction.party_id).first();

    await this.knex.transaction(async (trx) => {
      await this.esign.markFailed(transactionId, failureCode, 'FAILED', trx);
      await trx('signature_events').insert({
        agreement_id: agreement.id,
        party_id: party.id,
        agreement_version: agreement.current_version,
        event_type: 'FAILED',
        document_hash: transaction.document_hash,
        esign_transaction_id: transactionId,
        ip_address: ctx.ipAddress ?? null,
      });

      const signingStates = Object.values(SIGNING_PARTY).map((p) => p.signingState);
      if (signingStates.includes(agreement.status)) {
        await this.workflow.transition(
          {
            agreementId: agreement.id,
            action: (Object.values(SIGNING_PARTY).find(
            (p) => p.signingState === agreement.status,
          ) as SigningPartySpec).fail,
            actorId: null,
            actorRoles: ['SYSTEM'],
            trigger: 'PROVIDER_CALLBACK',
            auditEvent: AuditEvent.SIGNATURE_FAILED,
            auditData: { transactionId, failureCode, attemptNo: transaction.attempt_no },
          },
          trx,
        );
      }
    });
  }

  // ── Rejection (FR-015) ──────────────────────────────────────────────────────

  async reject(
    params: { agreementId: string; reason: string; actor: Principal },
    ctx: ActionContext = {},
  ): Promise<void> {
    const agreement = await this.workflow.get(params.agreementId);

    /*
     * Which rejection edge applies follows from the state, not from the caller's
     * claim about who they are: the employee's states take EMPLOYEE_REJECT, the
     * MD's take REJECT. assertTransition then checks the actor holds that role, so
     * an employee cannot reject from the MD's states by asking for the MD's edge.
     */
    const employeeStates = ['PENDING_EMPLOYEE_SIGNATURE', 'EMPLOYEE_SIGNING'];
    const byEmployee = employeeStates.includes(agreement.status);
    const action: WorkflowAction = byEmployee ? 'EMPLOYEE_REJECT' : 'REJECT';
    const party = await this.agreements.party(agreement.id, byEmployee ? 'EMPLOYEE' : 'MD');

    await this.knex.transaction(async (trx) => {
      await trx('signature_events').insert({
        agreement_id: agreement.id,
        party_id: party.id,
        agreement_version: agreement.current_version,
        event_type: 'REJECTED',
        document_hash: (
          await this.documents.currentVersion(agreement.id, agreement.current_version, trx)
        ).document_hash,
        ip_address: ctx.ipAddress ?? null,
      });

      await this.workflow.transition(
        {
          agreementId: agreement.id,
          action,
          actorId: params.actor.userId,
          actorRoles: params.actor.roles,
          trigger: 'USER',
          reason: params.reason,
          auditEvent: AuditEvent.MD_REJECTED,
          auditContext: ctx,
          patch: {
            rejected_reason: params.reason,
            rejected_by: params.actor.userId,
            rejected_at: new Date(),
            expires_at: null,
          },
        },
        trx,
      );

      // FR-015b — the stamp stays with the agreement across correction cycles.
      await this.notifications.enqueue(
        {
          agreementId: agreement.id,
          eventType: 'REJECTED',
          recipients: ['AGENT'],
          payload: { reason: params.reason, rejectedBy: 'MD' },
        },
        trx,
      );
    });
  }

  // ── Finalization (FR-016, FR-018, BR-007, BR-008) ───────────────────────────

  /**
   * Runs inside the MD-signature transaction. The completion notification is
   * written to the outbox here and dispatched only after commit, so BR-008 holds
   * in both directions: no email without a committed completion, and no committed
   * completion without an email eventually going out.
   */
  private async finalize(agreementId: string, finalHash: string, trx: Knex.Transaction): Promise<void> {
    await this.stamps.markUsed(agreementId, null, trx);

    await this.audit.record(
      AuditEvent.FINAL_DOCUMENT_GENERATED,
      { documentHash: finalHash },
      { agreementId },
      trx,
    );
    await this.audit.record(
      AuditEvent.AGREEMENT_COMPLETED,
      { documentHash: finalHash },
      { agreementId },
      trx,
    );

    /*
     * DEC-028 as amended by DEC-033 — every party that signed, plus Accounts.
     *
     * The employee is included because they signed: a signer who cannot obtain
     * the document carrying their own signature would have to ask someone else
     * for it. Accounts signs nothing and is notified for payment processing.
     */
    await this.notifications.enqueue(
      {
        agreementId,
        eventType: 'COMPLETED',
        recipients: ['AGENT', 'EMPLOYEE', 'MD', 'ACCOUNTS'],
        payload: { documentHash: finalHash },
      },
      trx,
    );
  }

  /** BR-001 — only the party the agreement names may act as that party. */
  private assertActorIsParty(
    actor: Principal,
    party: { id: string; user_id: string | null; email: string; party_type: string },
  ): void {
    if (actor.scopedPartyId) {
      if (actor.scopedPartyId !== party.id) {
        throw new ForbiddenError('This access link is not for this party', 'BR-001');
      }
      return;
    }
    const matchesUser = party.user_id && party.user_id === actor.userId;
    const matchesEmail = party.email.toLowerCase() === actor.email.toLowerCase();
    if (!matchesUser && !matchesEmail) {
      throw new ForbiddenError(
        `You are not the ${party.party_type} named on this agreement`,
        'BR-001',
      );
    }
  }
}

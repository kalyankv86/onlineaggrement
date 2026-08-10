import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX } from '../common/database/database.module';
import { EsignService } from '../esign/esign.service';
import { SigningService } from '../signing/signing.service';
import { WorkflowService } from '../workflow/workflow.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService, AuditEvent } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.service';

/**
 * Background jobs (SDD §15).
 *
 * Every one of these exists because some part of the system can silently stall:
 * a lost callback strands a signature, an unactioned agreement sits forever, a
 * queued email never leaves, a tampered audit row goes unnoticed. Each job is the
 * detection mechanism for one of those.
 */
@Injectable()
export class ScheduledJobsService {
  private readonly log = new Logger(ScheduledJobsService.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly esign: EsignService,
    private readonly signing: SigningService,
    private readonly workflow: WorkflowService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  /** Email dispatch — the outbox drain (BR-008). */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async dispatchNotifications(): Promise<void> {
    try {
      const { sent, failed } = await this.notifications.dispatchPending();
      if (sent || failed) this.log.log(`notifications dispatched: ${sent} sent, ${failed} failed`);
    } catch (e) {
      this.log.error(`notification dispatch failed: ${(e as Error).message}`);
    }
  }

  /**
   * FR-024 / AC-14 — reconcile in-flight signing transactions against the
   * provider, so a dropped callback cannot leave an agreement stuck in
   * AGENT_SIGNING or MD_SIGNING forever.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileSigningTransactions(): Promise<number> {
    let reconciled = 0;
    try {
      for (const tx of await this.esign.openTransactions(60)) {
        const status = await this.esign.getProviderStatus(tx.provider_transaction_id);
        if (status.status === 'SIGNED') {
          this.log.warn(
            `transaction ${tx.id} was SIGNED at the provider but no callback arrived — recovering`,
          );
          await this.signing.completeSignature(tx.id);
          reconciled += 1;
        } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(status.status)) {
          await this.signing.failSignature(tx.id, status.failureCode ?? status.status);
          reconciled += 1;
        }
      }
    } catch (e) {
      this.log.error(`reconciliation failed: ${(e as Error).message}`);
    }
    return reconciled;
  }

  /** FR-021 — expire agreements whose stage SLA has elapsed. */
  @Cron(CronExpression.EVERY_HOUR)
  async expireOverdueAgreements(): Promise<number> {
    let expired = 0;
    for (const agreement of await this.workflow.findExpired()) {
      try {
        await this.workflow.transition({
          agreementId: agreement.id,
          action: 'EXPIRE',
          actorId: null,
          actorRoles: ['SYSTEM'],
          trigger: 'SCHEDULER',
          auditEvent: AuditEvent.AGREEMENT_EXPIRED,
          auditData: { expiredFrom: agreement.status, deadline: agreement.expires_at },
        });
        expired += 1;
      } catch (e) {
        this.log.warn(`could not expire ${agreement.agreement_number}: ${(e as Error).message}`);
      }
    }
    if (expired) this.log.log(`${expired} agreement(s) expired`);
    return expired;
  }

  /** FR-022 — reminders at the configured cadence. */
  @Cron(CronExpression.EVERY_6_HOURS)
  async sendReminders(): Promise<number> {
    const sent = await this.notifications.sendDueReminders();
    if (sent) this.log.log(`${sent} reminder(s) queued`);
    return sent;
  }

  /**
   * FR-025 / AC-16 — walk every audit chain and alert on any break. This is the
   * layer that catches tampering by an actor holding database privileges, who
   * could have disabled the triggers.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async verifyAuditChains(): Promise<{ checked: number; broken: string[] }> {
    const chains = await this.knex('audit_chain_heads').pluck<string[]>('agreement_id');
    const broken: string[] = [];

    for (const agreementId of chains) {
      const isNil = agreementId === '00000000-0000-0000-0000-000000000000';
      const result = await this.audit.verifyChain(isNil ? null : agreementId);
      if (!result.intact) {
        broken.push(agreementId);
        this.log.error(
          `AUDIT CHAIN BROKEN for ${agreementId}: ${result.reason} (record ${result.brokenAtId})`,
        );
        // Recorded in the trail itself, which starts a fresh verifiable segment.
        await this.audit.record(AuditEvent.AUDIT_CHAIN_BROKEN, {
          chain: agreementId,
          reason: result.reason,
          brokenAtId: result.brokenAtId,
        });
      }
    }

    this.log.log(`audit chain verification: ${chains.length} checked, ${broken.length} broken`);
    return { checked: chains.length, broken };
  }

  /**
   * SDD §15 — document integrity checks. Re-verifies the signatures on every
   * completed agreement, so a storage-level corruption is found by us rather than
   * by a counterparty in a dispute.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async verifyCompletedDocuments(): Promise<{ checked: number; failed: string[] }> {
    const finals = await this.knex('agreement_versions')
      .join('agreements', 'agreements.id', 'agreement_versions.agreement_id')
      .where('agreement_versions.signature_state', 'FINAL')
      .where('agreements.completed_at', '>', new Date(Date.now() - 90 * 86_400_000))
      .select('agreement_versions.file_key', 'agreements.id', 'agreements.agreement_number');

    const failed: string[] = [];
    for (const row of finals) {
      try {
        const report = await this.documents.verifyStored(row.file_key);
        if (!report.allValid) {
          failed.push(row.agreement_number);
          await this.esign.recordIntegrityAlert(row.id, {
            source: 'scheduled-integrity-check',
            issues: report.signatures.filter((s) => !s.valid),
          });
        }
      } catch (e) {
        failed.push(row.agreement_number);
        this.log.error(`integrity check failed for ${row.agreement_number}: ${(e as Error).message}`);
      }
    }

    this.log.log(`document integrity: ${finals.length} checked, ${failed.length} failed`);
    return { checked: finals.length, failed };
  }
}

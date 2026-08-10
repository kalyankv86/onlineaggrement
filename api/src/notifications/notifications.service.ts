import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import * as nodemailer from 'nodemailer';
import { KNEX, Db } from '../common/database/database.module';
import { AuditService, AuditEvent } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.service';

export type NotificationEvent =
  | 'AGENT_SIGNED'
  | 'EMPLOYEE_APPROVED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'REMINDER';

export type PartyType = 'AGENT' | 'EMPLOYEE' | 'MD';

export interface EnqueueRequest {
  agreementId: string;
  eventType: NotificationEvent;
  recipients: PartyType[];
  payload?: Record<string, unknown>;
}

const SUBJECTS: Record<NotificationEvent, (n: string) => string> = {
  AGENT_SIGNED: (n) => `Action required: agreement ${n} awaits your approval`,
  EMPLOYEE_APPROVED: (n) => `Action required: agreement ${n} awaits your signature`,
  COMPLETED: (n) => `Agreement ${n} is complete`,
  REJECTED: (n) => `Agreement ${n} was rejected`,
  REMINDER: (n) => `Reminder: agreement ${n} is awaiting your action`,
};

/**
 * Notification fan-out (SDD §12) over a transactional outbox (SDD v1.1 §B9).
 *
 * `enqueue` writes rows inside the caller's transaction and dispatch happens
 * strictly after commit. That is what makes BR-008 hold in both directions: no
 * completion email is sent for an agreement that failed to finalize, and no
 * committed completion silently skips its email.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    private readonly config: ConfigService,
  ) {
    this.from = config.get<string>('mail.from') ?? 'GTIDS <noreply@gtids.example>';
    this.transporter =
      config.get<string>('mail.transport') === 'smtp'
        ? nodemailer.createTransport({
            host: config.get<string>('mail.host'),
            port: config.get<number>('mail.port'),
            secure: config.get<number>('mail.port') === 465,
            auth: config.get<string>('mail.user')
              ? {
                  user: config.get<string>('mail.user'),
                  pass: config.get<string>('mail.password'),
                }
              : undefined,
          })
        : nodemailer.createTransport({ jsonTransport: true });
  }

  /** Write the notification and its per-recipient rows inside the caller's transaction. */
  async enqueue(req: EnqueueRequest, db: Db = this.knex): Promise<string> {
    const agreement = await db('agreements').where('id', req.agreementId).first();
    const parties = await db('agreement_parties')
      .where('agreement_id', req.agreementId)
      .whereIn('party_type', req.recipients);

    const [notification] = await db('notifications')
      .insert({
        agreement_id: req.agreementId,
        event_type: req.eventType,
        subject: SUBJECTS[req.eventType](agreement.agreement_number),
        template_code: req.eventType,
        payload: JSON.stringify({
          agreementNumber: agreement.agreement_number,
          ...(req.payload ?? {}),
        }),
      })
      .returning('id');

    // SDD §12 requires one recipient record per party — three on completion — so a
    // bounce to one party cannot be mistaken for delivery to all.
    await db('notification_recipients').insert(
      parties.map((p) => ({
        notification_id: notification.id,
        party_id: p.id,
        email: p.email,
        status: 'QUEUED',
      })),
    );

    await db('outbox_events').insert({
      aggregate_id: req.agreementId,
      event_type: `NOTIFICATION_${req.eventType}`,
      payload: JSON.stringify({ notificationId: notification.id }),
    });

    return notification.id;
  }

  /**
   * Dispatch loop, run by the worker after transactions have committed. Each
   * recipient is attempted independently.
   */
  async dispatchPending(limit = 50): Promise<{ sent: number; failed: number }> {
    const pending = await this.knex('notification_recipients')
      .join('notifications', 'notifications.id', 'notification_recipients.notification_id')
      .whereIn('notification_recipients.status', ['QUEUED', 'FAILED'])
      .where('notification_recipients.attempt_count', '<', 5)
      .orderBy('notification_recipients.created_at', 'asc')
      .limit(limit)
      .select(
        'notification_recipients.id',
        'notification_recipients.email',
        'notification_recipients.attempt_count',
        'notifications.id as notification_id',
        'notifications.agreement_id',
        'notifications.subject',
        'notifications.event_type',
        'notifications.payload',
      );

    let sent = 0;
    let failed = 0;

    for (const row of pending) {
      try {
        const body = await this.renderBody(row);
        const info = await this.transporter.sendMail({
          from: this.from,
          to: row.email,
          subject: row.subject,
          text: body.text,
          html: body.html,
        });

        await this.knex('notification_recipients')
          .where('id', row.id)
          .update({
            status: 'SENT',
            sent_at: new Date(),
            provider_message_id: info.messageId ?? null,
            attempt_count: row.attempt_count + 1,
            failure_reason: null,
            updated_at: new Date(),
          });

        await this.audit.record(
          AuditEvent.EMAIL_SENT,
          { recipient: row.email, event: row.event_type, messageId: info.messageId },
          { agreementId: row.agreement_id },
        );
        sent += 1;
      } catch (e) {
        const reason = (e as Error).message;
        await this.knex('notification_recipients')
          .where('id', row.id)
          .update({
            status: 'FAILED',
            attempt_count: row.attempt_count + 1,
            failure_reason: reason,
            updated_at: new Date(),
          });
        await this.audit.record(
          AuditEvent.EMAIL_FAILED,
          { recipient: row.email, event: row.event_type, reason },
          { agreementId: row.agreement_id },
        );
        this.log.warn(`email to ${row.email} failed: ${reason}`);
        failed += 1;
      }
    }

    await this.knex('notifications')
      .whereIn(
        'id',
        pending.map((p) => p.notification_id),
      )
      .whereNull('dispatched_at')
      .update({ dispatched_at: new Date() });

    return { sent, failed };
  }

  /**
   * The completion mail carries a short-lived link, not the PDF as an attachment.
   * Attachments outlive their authorization; a 5-minute pre-signed URL does not
   * (SRS §12).
   */
  private async renderBody(row: {
    agreement_id: string;
    event_type: NotificationEvent;
    payload: Record<string, unknown>;
  }): Promise<{ text: string; html: string }> {
    const agreementNumber = String(row.payload.agreementNumber ?? '');
    const agreement = await this.knex('agreements').where('id', row.agreement_id).first();

    let link = '';
    if (row.event_type === 'COMPLETED') {
      const version = await this.knex('agreement_versions')
        .where({ agreement_id: row.agreement_id, signature_state: 'FINAL' })
        .orderBy('created_at', 'desc')
        .first();
      if (version) link = await this.documents.signedUrl(version.file_key);
    }

    const verifyUrl = agreement?.verification_token
      ? `${this.config.get<string>('publicVerifyBaseUrl')}/${agreement.verification_token}`
      : '';

    const lines: Record<NotificationEvent, string[]> = {
      COMPLETED: [
        `Agreement ${agreementNumber} has been fully executed.`,
        'All three parties have completed their steps and the signed document is final.',
        link ? `Download (link expires shortly): ${link}` : '',
        verifyUrl ? `Verify at any time: ${verifyUrl}` : '',
      ],
      AGENT_SIGNED: [
        `Agreement ${agreementNumber} has been signed by the Agent and is awaiting your approval.`,
      ],
      EMPLOYEE_APPROVED: [
        `Agreement ${agreementNumber} has been approved and is awaiting your signature.`,
      ],
      REJECTED: [
        `Agreement ${agreementNumber} was rejected by the ${row.payload.rejectedBy ?? 'approver'}.`,
        `Reason: ${row.payload.reason ?? 'not recorded'}`,
      ],
      REMINDER: [`Agreement ${agreementNumber} is still awaiting your action.`],
    };

    const text = lines[row.event_type].filter(Boolean).join('\n\n');
    return {
      text,
      html: `<div style="font-family:system-ui,sans-serif;line-height:1.6">${lines[row.event_type]
        .filter(Boolean)
        .map((l) => `<p>${escapeHtml(l)}</p>`)
        .join('')}<hr><p style="color:#666;font-size:12px">Gramtarang Inclusive Development Services</p></div>`,
    };
  }

  /** FR-022 — reminders on the configured cadence for whoever is holding things up. */
  async sendDueReminders(now: Date = new Date()): Promise<number> {
    const candidates = await this.knex('agreements')
      .join('stage_slas', function () {
        this.on('stage_slas.agreement_type_id', '=', 'agreements.agreement_type_id').andOn(
          'stage_slas.stage',
          '=',
          'agreements.status',
        );
      })
      .whereNotNull('agreements.expires_at')
      .whereNotIn('agreements.status', ['COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED'])
      .select(
        'agreements.id',
        'agreements.status',
        'agreements.expires_at',
        'stage_slas.sla_days',
        'stage_slas.reminder_days',
      );

    let sent = 0;
    for (const c of candidates) {
      const deadline = new Date(c.expires_at);
      const elapsedDays = c.sla_days - Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000);
      if (!(c.reminder_days as number[]).includes(elapsedDays)) continue;

      const recipient = pendingRecipient(c.status);
      if (!recipient) continue;

      // One reminder per day per agreement, whatever the sweep interval.
      const already = await this.knex('notifications')
        .where({ agreement_id: c.id, event_type: 'REMINDER' })
        .where('created_at', '>', new Date(now.getTime() - 20 * 3_600_000))
        .first();
      if (already) continue;

      await this.enqueue({
        agreementId: c.id,
        eventType: 'REMINDER',
        recipients: [recipient],
        payload: { elapsedDays, dueAt: deadline.toISOString() },
      });
      sent += 1;
    }
    return sent;
  }
}

function pendingRecipient(status: string): PartyType | null {
  if (status === 'READY_FOR_AGENT_SIGNATURE' || status === 'AGENT_SIGNING') return 'AGENT';
  if (status === 'PENDING_EMPLOYEE_APPROVAL' || status === 'EMPLOYEE_APPROVING') return 'EMPLOYEE';
  if (status === 'PENDING_MD_SIGNATURE' || status === 'MD_SIGNING') return 'MD';
  return null;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

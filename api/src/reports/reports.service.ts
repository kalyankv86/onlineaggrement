import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX } from '../common/database/database.module';

/** FR-020 — agreement, stamp, workflow, signature and completion reports. */
@Injectable()
export class ReportsService {
  constructor(@Inject(KNEX) private readonly knex: Knex) {}

  async agreementSummary(from?: Date, to?: Date) {
    const scope = (q: Knex.QueryBuilder) => {
      if (from) q.where('created_at', '>=', from);
      if (to) q.where('created_at', '<=', to);
      return q;
    };

    const [byStatus, byType, completion] = await Promise.all([
      scope(this.knex('agreements')).select('status').count('* as count').groupBy('status'),
      scope(this.knex('agreements'))
        .join('agreement_types', 'agreement_types.id', 'agreements.agreement_type_id')
        .select('agreement_types.code', 'agreement_types.name')
        .count('* as count')
        .groupBy('agreement_types.code', 'agreement_types.name'),
      scope(this.knex('agreements'))
        .whereNotNull('completed_at')
        .select(
          this.knex.raw(`count(*) AS completed`),
          this.knex.raw(
            `round(avg(extract(epoch FROM (completed_at - created_at)) / 3600)::numeric, 2) AS avg_hours_to_complete`,
          ),
        )
        .first(),
    ]);

    return { byStatus, byType, completion };
  }

  /** Where agreements are actually getting stuck — the operational question. */
  async workflowAging() {
    return this.knex('agreements')
      .whereNotIn('status', ['COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED'])
      .select('status')
      .count('* as count')
      .select(
        this.knex.raw(
          `round(avg(extract(epoch FROM (now() - updated_at)) / 86400)::numeric, 1) AS avg_days_in_state`,
        ),
        this.knex.raw(`count(*) FILTER (WHERE expires_at < now()) AS overdue`),
      )
      .groupBy('status');
  }

  async signatureReport(from?: Date, to?: Date) {
    const q = this.knex('esign_transactions')
      .select('provider', 'status')
      .count('* as count')
      .avg({ avg_attempts: 'attempt_no' })
      .groupBy('provider', 'status');
    if (from) q.where('initiated_at', '>=', from);
    if (to) q.where('initiated_at', '<=', to);

    const failures = await this.knex('esign_transactions')
      .whereNotNull('failure_code')
      .select('failure_code')
      .count('* as count')
      .groupBy('failure_code')
      .orderBy('count', 'desc')
      .limit(10);

    return { byStatus: await q, topFailures: failures };
  }

  async stampReport() {
    const [inventory, usage] = await Promise.all([
      this.knex('stamp_papers')
        .select('status', 'state_code')
        .count('* as count')
        .sum({ face_value: 'denomination' })
        .groupBy('status', 'state_code'),
      this.knex('stamp_allocations')
        .whereNull('released_at')
        .count('* as active_allocations')
        .first(),
    ]);
    return { inventory, usage };
  }

  /** Delivery outcomes per recipient, so a single bounce is visible (SDD §12). */
  async notificationReport() {
    return this.knex('notification_recipients')
      .join('notifications', 'notifications.id', 'notification_recipients.notification_id')
      .select('notifications.event_type', 'notification_recipients.status')
      .count('* as count')
      .groupBy('notifications.event_type', 'notification_recipients.status');
  }

  /** FR-025 — chain integrity across every agreement, for the audit dashboard. */
  async auditIntegritySummary() {
    const heads = await this.knex('audit_chain_heads').select('agreement_id', 'record_count');
    const actual = (await this.knex('audit_logs')
      .select('agreement_id')
      .count('* as count')
      .groupBy('agreement_id')) as unknown as { agreement_id: string | null; count: string }[];

    const actualByAgreement = new Map<string, number>(
      actual.map((r) => [
        r.agreement_id ?? '00000000-0000-0000-0000-000000000000',
        Number(r.count),
      ]),
    );

    const mismatches = heads.filter(
      (h: { agreement_id: string; record_count: string }) =>
        actualByAgreement.get(h.agreement_id) !== Number(h.record_count),
    );

    return {
      chains: heads.length,
      totalRecords: heads.reduce(
        (sum: number, h: { record_count: string }) => sum + Number(h.record_count),
        0,
      ),
      suspectChains: mismatches.map((m: { agreement_id: string }) => m.agreement_id),
      intact: mismatches.length === 0,
    };
  }
}

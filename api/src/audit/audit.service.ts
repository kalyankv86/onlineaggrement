import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX, Db } from '../common/database/database.module';

/** SRS §10 — the material actions that must appear in the trail. */
export const AuditEvent = {
  AGREEMENT_CREATED: 'AGREEMENT_CREATED',
  AGREEMENT_CORRECTED: 'AGREEMENT_CORRECTED',
  STAMP_UPLOADED: 'STAMP_UPLOADED',
  STAMP_ALLOCATED: 'STAMP_ALLOCATED',
  STAMP_RELEASED: 'STAMP_RELEASED',
  STAMP_MARKED_USED: 'STAMP_MARKED_USED',
  IDENTITY_VERIFICATION_INITIATED: 'IDENTITY_VERIFICATION_INITIATED',
  IDENTITY_VERIFICATION_COMPLETED: 'IDENTITY_VERIFICATION_COMPLETED',
  AGREEMENT_GENERATED: 'AGREEMENT_GENERATED',
  DOCUMENT_VIEWED: 'DOCUMENT_VIEWED',
  AGENT_SIGN_INITIATED: 'AGENT_SIGN_INITIATED',
  AGENT_SIGNED: 'AGENT_SIGNED',
  EMPLOYEE_APPROVED: 'EMPLOYEE_APPROVED',
  EMPLOYEE_REJECTED: 'EMPLOYEE_REJECTED',
  MD_SIGN_INITIATED: 'MD_SIGN_INITIATED',
  MD_SIGNED: 'MD_SIGNED',
  MD_REJECTED: 'MD_REJECTED',
  AGREEMENT_COMPLETED: 'AGREEMENT_COMPLETED',
  AGREEMENT_CANCELLED: 'AGREEMENT_CANCELLED',
  AGREEMENT_EXPIRED: 'AGREEMENT_EXPIRED',
  FINAL_DOCUMENT_GENERATED: 'FINAL_DOCUMENT_GENERATED',
  EMAIL_SENT: 'EMAIL_SENT',
  EMAIL_FAILED: 'EMAIL_FAILED',
  DOCUMENT_DOWNLOADED: 'DOCUMENT_DOWNLOADED',
  DOCUMENT_VERIFIED: 'DOCUMENT_VERIFIED',
  SIGNATURE_FAILED: 'SIGNATURE_FAILED',
  SIGNATURE_INTEGRITY_ALERT: 'SIGNATURE_INTEGRITY_ALERT',
  PARTY_ACCESS_ISSUED: 'PARTY_ACCESS_ISSUED',
  PARTY_ACCESS_REDEEMED: 'PARTY_ACCESS_REDEEMED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  ROLE_GRANTED: 'ROLE_GRANTED',
  AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
} as const;
export type AuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent];

export interface AuditContext {
  agreementId?: string | null;
  agreementVersion?: number | null;
  actorId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(@Inject(KNEX) private readonly knex: Knex) {}

  /**
   * Append one audit record. `db` should be the caller's transaction so the audit
   * entry commits or rolls back with the action it describes — an audit record for
   * a transition that did not happen is worse than no record.
   *
   * prev_hash/row_hash are computed by the database trigger (migration 009), not
   * here, so application code cannot choose the linkage.
   */
  async record(
    eventType: AuditEventType,
    eventData: Record<string, unknown>,
    ctx: AuditContext = {},
    db: Db = this.knex,
  ): Promise<void> {
    await db('audit_logs').insert({
      agreement_id: ctx.agreementId ?? null,
      agreement_version: ctx.agreementVersion ?? null,
      actor_id: ctx.actorId ?? null,
      event_type: eventType,
      event_data: JSON.stringify(eventData),
      ip_address: ctx.ipAddress ?? null,
      user_agent: ctx.userAgent ?? null,
    });
  }

  async forAgreement(agreementId: string): Promise<unknown[]> {
    return this.knex('audit_logs')
      .leftJoin('users', 'users.id', 'audit_logs.actor_id')
      .where('audit_logs.agreement_id', agreementId)
      .orderBy('audit_logs.id', 'asc')
      .select(
        'audit_logs.id',
        'audit_logs.event_type',
        'audit_logs.event_data',
        'audit_logs.agreement_version',
        'audit_logs.ip_address',
        'audit_logs.created_at',
        'audit_logs.prev_hash',
        'audit_logs.row_hash',
        'users.full_name as actor_name',
        'users.email as actor_email',
      );
  }

  /**
   * Walk a chain and recompute every link — AC-16.
   *
   * The recomputation runs in SQL using the *same expression* as the trigger in
   * migration 009. Reimplementing it in TypeScript would mean reproducing
   * Postgres's jsonb text rendering (which orders keys by length, then bytewise,
   * and inserts its own separators) — a brittle dependency that would eventually
   * produce false alarms. Recomputing server-side keeps the two definitions in
   * step by construction.
   *
   * This still detects tampering by a privileged actor: disabling the trigger and
   * editing a row changes `event_data`, so the recomputed digest no longer matches
   * the stored `row_hash`, and the break is located to a specific record.
   */
  async verifyChain(agreementId: string | null): Promise<{
    agreementId: string;
    intact: boolean;
    recordCount: number;
    brokenAtId?: string;
    reason?: string;
  }> {
    const key = agreementId ?? NIL_UUID;
    const scope = agreementId ? 'agreement_id = ?' : 'agreement_id IS NULL';
    const bindings = agreementId ? [agreementId] : [];

    const { rows } = await this.knex.raw(
      `
      WITH scoped AS (
        SELECT * FROM audit_logs WHERE ${scope}
      ), recomputed AS (
        SELECT
          id,
          prev_hash,
          row_hash,
          encode(sha256(convert_to(
            prev_hash
            || COALESCE(agreement_id::text, '')
            || COALESCE(agreement_version::text, '')
            || COALESCE(actor_id::text, '')
            || event_type
            || COALESCE(event_data::text, '{}')
            || to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
            'UTF8')), 'hex') AS expected_row_hash,
          LAG(row_hash) OVER (ORDER BY id) AS predecessor_hash
        FROM scoped
      )
      SELECT
        (SELECT count(*) FROM scoped) AS total,
        r.id, r.reason
      FROM (
        SELECT id,
          CASE
            WHEN expected_row_hash <> row_hash
              THEN 'record content does not match its stored hash'
            ELSE 'prev_hash does not match predecessor — a record was removed or altered'
          END AS reason
        FROM recomputed
        WHERE expected_row_hash <> row_hash
           OR prev_hash IS DISTINCT FROM COALESCE(predecessor_hash, repeat('0', 64))
        ORDER BY id
        LIMIT 1
      ) r RIGHT JOIN (SELECT 1) dummy ON true
      `,
      bindings,
    );

    const result = rows[0] ?? { total: 0, id: null, reason: null };
    const recordCount = Number(result.total ?? 0);

    if (result.id !== null && result.id !== undefined) {
      return {
        agreementId: key,
        intact: false,
        recordCount,
        brokenAtId: String(result.id),
        reason: `record ${result.id}: ${result.reason}`,
      };
    }

    // A truncated tail leaves the surviving records self-consistent, so compare
    // against the recorded head as well.
    const head = await this.knex('audit_chain_heads').where('agreement_id', key).first();
    if (head && Number(head.record_count) !== recordCount) {
      return {
        agreementId: key,
        intact: false,
        recordCount,
        reason: `chain head expects ${head.record_count} records but ${recordCount} remain — the tail was truncated`,
      };
    }

    return { agreementId: key, intact: true, recordCount };
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX, Db } from '../common/database/database.module';
import { AuditService, AuditEvent, AuditEventType, AuditContext } from '../audit/audit.service';
import { NotFoundError, ConflictError } from '../common/errors/domain.errors';
import {
  AgreementState,
  WorkflowAction,
  Role,
  assertTransition,
  availableActions,
  PENDING_ACTION_STATES,
} from './state-machine';
import { addDays } from '../common/util/financial-year';

export interface AgreementRow {
  id: string;
  agreement_number: string;
  agreement_type_id: string;
  template_version_id: string;
  status: AgreementState;
  current_version: number;
  row_version: number;
  expires_at: Date | null;
  data: Record<string, unknown>;
  created_by: string;
}

export interface TransitionRequest {
  agreementId: string;
  action: WorkflowAction;
  actorId: string | null;
  actorRoles: Role[];
  trigger: 'USER' | 'SYSTEM' | 'PROVIDER_CALLBACK' | 'SCHEDULER';
  reason?: string;
  auditEvent?: AuditEventType;
  auditData?: Record<string, unknown>;
  auditContext?: Pick<AuditContext, 'ipAddress' | 'userAgent'>;
  /** Extra columns to set in the same statement as the status change. */
  patch?: Record<string, unknown>;
}

/**
 * The only component permitted to write `agreements.status`.
 *
 * Every transition runs the sequence from SDD v1.1 §B9: take a row lock, re-read
 * the state under that lock, validate against the transition table, apply, log the
 * transition, write the audit record — all inside one transaction. Locking is what
 * makes the guarantee hold across API instances; validating *after* the lock is
 * what makes it hold against a concurrent request that already passed validation.
 */
@Injectable()
export class WorkflowService {
  private readonly log = new Logger(WorkflowService.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly audit: AuditService,
  ) {}

  /**
   * Apply a transition. If `db` is supplied the caller's transaction is joined,
   * so document writes and state changes commit together.
   */
  async transition(req: TransitionRequest, db?: Db): Promise<AgreementRow> {
    const run = async (trx: Knex.Transaction): Promise<AgreementRow> => {
      const agreement = await this.lockAgreement(req.agreementId, trx);

      const outcome = assertTransition(agreement.status, req.action, req.actorRoles, {
        reason: req.reason,
      });

      const patch: Record<string, unknown> = {
        status: outcome.to,
        row_version: agreement.row_version + 1,
        updated_at: new Date(),
        ...(req.patch ?? {}),
      };

      // The SLA clock restarts whenever the agreement lands on a human (FR-021).
      if (PENDING_ACTION_STATES.includes(outcome.to) && patch.expires_at === undefined) {
        patch.expires_at = await this.slaDeadline(agreement.agreement_type_id, outcome.to, trx);
      }

      const updated = await trx('agreements')
        .where({ id: agreement.id, row_version: agreement.row_version })
        .update(patch)
        .returning('*');

      if (updated.length === 0) {
        // Another writer moved between our lock and update — impossible under the
        // lock, but the guard costs nothing and turns a silent no-op into an error.
        throw new ConflictError(
          'Agreement changed concurrently; re-read and retry',
          undefined,
          { agreementId: agreement.id },
        );
      }

      await trx('workflow_transitions').insert({
        agreement_id: agreement.id,
        agreement_version: agreement.current_version,
        from_state: outcome.from,
        to_state: outcome.to,
        actor_id: req.actorId,
        trigger: req.trigger,
        reason: req.reason ?? null,
      });

      await this.audit.record(
        req.auditEvent ?? (`STATE_${outcome.to}` as AuditEventType),
        {
          from: outcome.from,
          to: outcome.to,
          action: req.action,
          rule: outcome.rule,
          ...(req.reason ? { reason: req.reason } : {}),
          ...(req.auditData ?? {}),
        },
        {
          agreementId: agreement.id,
          agreementVersion: agreement.current_version,
          actorId: req.actorId,
          ipAddress: req.auditContext?.ipAddress,
          userAgent: req.auditContext?.userAgent,
        },
        trx,
      );

      this.log.log(
        `${agreement.agreement_number}: ${outcome.from} -> ${outcome.to} (${req.action}, ${outcome.rule})`,
      );
      return updated[0] as AgreementRow;
    };

    return db && 'commit' in db
      ? run(db as Knex.Transaction)
      : this.knex.transaction((trx) => run(trx));
  }

  /**
   * Chain transitions that are consequences rather than decisions — a successful
   * agent signature always advances to employee approval, so the two are applied
   * together and commit together.
   */
  async transitionChain(reqs: TransitionRequest[], db?: Db): Promise<AgreementRow> {
    const run = async (trx: Knex.Transaction) => {
      let last: AgreementRow | null = null;
      for (const req of reqs) last = await this.transition(req, trx);
      return last!;
    };
    return db && 'commit' in db
      ? run(db as Knex.Transaction)
      : this.knex.transaction((trx) => run(trx));
  }

  /** SELECT ... FOR UPDATE — every state change serialises here. */
  async lockAgreement(agreementId: string, trx: Knex.Transaction): Promise<AgreementRow> {
    const row = await trx('agreements').where('id', agreementId).forUpdate().first();
    if (!row) throw new NotFoundError('Agreement', agreementId);
    return row as AgreementRow;
  }

  async get(agreementId: string, db: Db = this.knex): Promise<AgreementRow> {
    const row = await db('agreements').where('id', agreementId).first();
    if (!row) throw new NotFoundError('Agreement', agreementId);
    return row as AgreementRow;
  }

  availableActions(state: AgreementState, roles: Role[]): WorkflowAction[] {
    return availableActions(state, roles);
  }

  async history(agreementId: string): Promise<unknown[]> {
    return this.knex('workflow_transitions')
      .leftJoin('users', 'users.id', 'workflow_transitions.actor_id')
      .where('workflow_transitions.agreement_id', agreementId)
      .orderBy('workflow_transitions.id', 'asc')
      .select(
        'workflow_transitions.id',
        'workflow_transitions.from_state',
        'workflow_transitions.to_state',
        'workflow_transitions.trigger',
        'workflow_transitions.reason',
        'workflow_transitions.agreement_version',
        'workflow_transitions.created_at',
        'users.full_name as actor_name',
      );
  }

  /** Per-type stage SLA, falling back to the configured default (DEC-008). */
  private async slaDeadline(
    agreementTypeId: string,
    stage: AgreementState,
    db: Db,
  ): Promise<Date> {
    const sla = await db('stage_slas')
      .where({ agreement_type_id: agreementTypeId, stage })
      .first();
    return addDays(new Date(), sla?.sla_days ?? 14);
  }

  /**
   * FR-015a / BR-004 — correction opens version N+1 on the same agreement record.
   *
   * Prior signatures are voided rather than carried: a corrected document is a
   * different document, so an earlier ByteRange digest no longer describes it.
   * Every prior version, hash and signature record is preserved for audit.
   */
  async correct(
    params: {
      agreementId: string;
      actorId: string;
      actorRoles: Role[];
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<AgreementRow> {
    return this.knex.transaction(async (trx) => {
      const agreement = await this.lockAgreement(params.agreementId, trx);

      const voided = await trx('agreement_versions')
        .where({ agreement_id: agreement.id, version_no: agreement.current_version })
        .whereIn('signature_state', ['AGENT_SIGNED', 'EMPLOYEE_ATTESTED', 'FINAL'])
        .count<{ count: string }[]>('* as count');

      await trx('agreement_version_history').insert({
        agreement_id: agreement.id,
        version_no: agreement.current_version,
        status_at_close: agreement.status,
        rejection_reason: (agreement as unknown as { rejected_reason?: string }).rejected_reason ?? null,
        superseded_by_version: agreement.current_version + 1,
        voided_signature_count: Number(voided[0]?.count ?? 0),
      });

      // Any open signing transaction on the closed version is dead.
      await trx('esign_transactions')
        .where({ agreement_id: agreement.id, agreement_version: agreement.current_version })
        .whereIn('status', ['INITIATED', 'PENDING_SIGNER'])
        .update({ status: 'CANCELLED', completed_at: new Date() });

      return this.transition(
        {
          agreementId: agreement.id,
          action: 'CORRECT',
          actorId: params.actorId,
          actorRoles: params.actorRoles,
          trigger: 'USER',
          auditEvent: AuditEvent.AGREEMENT_CORRECTED,
          auditData: {
            closedVersion: agreement.current_version,
            newVersion: agreement.current_version + 1,
            voidedSignatures: Number(voided[0]?.count ?? 0),
            closedFromStatus: agreement.status,
          },
          auditContext: { ipAddress: params.ipAddress, userAgent: params.userAgent },
          patch: {
            current_version: agreement.current_version + 1,
            rejected_reason: null,
            rejected_by: null,
            rejected_at: null,
            expires_at: null,
          },
        },
        trx,
      );
    });
  }

  /** Agreements whose stage SLA has elapsed — the sweep half of FR-021. */
  async findExpired(now: Date = new Date()): Promise<AgreementRow[]> {
    return this.knex('agreements')
      .whereNotNull('expires_at')
      .where('expires_at', '<', now)
      .whereNotIn('status', ['COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED'])
      .select('*') as unknown as Promise<AgreementRow[]>;
  }
}

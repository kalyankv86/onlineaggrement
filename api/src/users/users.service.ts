import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { randomBytes } from 'crypto';
import { KNEX } from '../common/database/database.module';
import { AuthService } from '../auth/auth.service';
import { AuditService, AuditEvent } from '../audit/audit.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors/domain.errors';

/** The roles an administrator may grant. SYSTEM is not among them. */
export const GRANTABLE_ROLES = [
  'SUPER_ADMIN',
  'AGREEMENT_ADMIN',
  'AGENT',
  'EMPLOYEE',
  'MD',
  'MD_DELEGATE',
  'AUDITOR',
] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export interface UserRow {
  id: string;
  email: string;
  /** Appears in the execution reference of every agreement they sign (DEC-036). */
  agent_code?: string | null;
  full_name: string;
  mobile: string | null;
  is_active: boolean;
  bank_id: string | null;
  bank_name: string | null;
  last_login_at: Date | null;
  locked_until: Date | null;
  roles: string[];
}

/**
 * User administration (DEC-031).
 *
 * The rule this service exists to hold is the relationship between the AGENT
 * role and a bank: an agent must have one, and nobody else may. Everything
 * downstream — which agreement text is executed, which employee countersigns,
 * whether an agent can reach another bank's paper — follows from that pairing,
 * and it is not expressible as a database constraint because a user's roles live
 * in another table.
 */
@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<UserRow[]> {
    return this.knex('users as u')
      .leftJoin('banks as b', 'b.id', 'u.bank_id')
      .where('u.user_type', 'INTERNAL')
      .orWhereNotNull('u.bank_id')
      .select(
        'u.id',
        'u.email',
        'u.full_name',
        'u.mobile',
        'u.is_active',
        'u.bank_id',
        'u.agent_code',
        'u.last_login_at',
        'u.locked_until',
        'b.name as bank_name',
      )
      .select(
        this.knex.raw(`coalesce((
          select array_agg(r.code order by r.code)
            from user_roles ur join roles r on r.id = ur.role_id
           where ur.user_id = u.id
        ), '{}') as roles`),
      )
      .orderBy('u.full_name');
  }

  /**
   * Create a user, or add roles to one that already exists.
   *
   * Idempotent on email for the same reason the command-line script is: an
   * administrator who presses the button twice should end up with one account
   * holding the right roles, not an error and a half-made user.
   */
  async upsert(
    input: {
      email: string;
      fullName: string;
      mobile?: string;
      roles: GrantableRole[];
      bankId?: string | null;
      password?: string;
    },
    actorId: string,
  ): Promise<{ user: UserRow; generatedPassword?: string }> {
    const email = input.email.trim().toLowerCase();
    if (input.roles.length === 0) {
      throw new ValidationError('Choose at least one role');
    }
    await this.assertBankPairing(input.roles, input.bankId ?? null);

    const existing = await this.knex('users').where('email', email).first();
    const generated = input.password ? undefined : this.generatePassword();
    const passwordHash = await this.auth.hashPassword(input.password ?? generated!);

    const userId = await this.knex.transaction(async (trx) => {
      let id: string;
      if (existing) {
        id = existing.id;
        await trx('users')
          .where('id', id)
          .update({
            full_name: input.fullName.trim(),
            mobile: input.mobile?.trim() || null,
            bank_id: input.bankId ?? null,
            // An existing account's password is only reset when one was supplied;
            // otherwise re-adding a role would silently lock the person out.
            ...(input.password ? { password_hash: passwordHash } : {}),
            is_active: true,
            updated_at: new Date(),
          });
      } else {
        const [row] = await trx('users')
          .insert({
            email,
            full_name: input.fullName.trim(),
            mobile: input.mobile?.trim() || null,
            password_hash: passwordHash,
            user_type: 'INTERNAL',
            bank_id: input.bankId ?? null,
          })
          .returning('id');
        id = row.id;
      }

      /*
       * DEC-036 — an agent needs a code before they can execute anything, since
       * it forms part of the execution reference. Assigned once and never
       * reassigned: the code appears in references that outlive the account, so
       * reusing it would give two agreements the same reference for different
       * people.
       */
      if (input.roles.includes('AGENT')) {
        const current = await trx('users').where('id', id).select('agent_code').first();
        if (!current?.agent_code) {
          await trx.raw(
            `UPDATE users SET agent_code = 'AG' || lpad((
               coalesce((SELECT max(nullif(regexp_replace(agent_code, '\\D', '', 'g'), '')::int)
                           FROM users), 0) + 1)::text, 4, '0')
             WHERE id = ?`,
            [id],
          );
        }
      }

      const roleIds = await trx('roles').whereIn('code', input.roles).select('id', 'code');
      if (roleIds.length !== input.roles.length) {
        const found = roleIds.map((r) => r.code);
        throw new NotFoundError('Role', input.roles.find((r) => !found.includes(r))!);
      }

      // Replace the role set rather than adding to it, so removing a role in the
      // UI actually removes it. Roles are the authorisation boundary; a stale one
      // left behind is a permission nobody intended to keep.
      await trx('user_roles').where('user_id', id).del();
      await trx('user_roles').insert(roleIds.map((r) => ({ user_id: id, role_id: r.id })));

      await this.audit.record(
        AuditEvent.ROLE_GRANTED,
        {
          email,
          roles: input.roles,
          bankId: input.bankId ?? null,
          created: !existing,
          passwordSet: !!input.password || !existing,
        },
        { actorId },
        trx,
      );
      return id;
    });

    const user = (await this.get(userId))!;
    this.log.log(
      `${existing ? 'updated' : 'created'} ${email} with roles ${input.roles.join(', ')}`,
    );
    return { user, generatedPassword: existing && !input.password ? undefined : generated };
  }

  async get(id: string): Promise<UserRow | undefined> {
    const rows = await this.list();
    return rows.find((u) => u.id === id);
  }

  async setActive(id: string, isActive: boolean, actorId: string): Promise<UserRow> {
    const user = await this.get(id);
    if (!user) throw new NotFoundError('User', id);

    if (!isActive) {
      await this.assertNotLastAdministrator(id);
      await this.assertNotADesignatedSigner(id, user.full_name);
    }

    await this.knex('users').where('id', id).update({
      is_active: isActive,
      // Clear any lockout on reactivation; otherwise a reactivated account can
      // still be refused and nothing on screen explains why.
      ...(isActive ? { locked_until: null, failed_login_count: 0 } : {}),
      updated_at: new Date(),
    });
    await this.audit.record(
      AuditEvent.CONFIGURATION_CHANGED,
      { change: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', email: user.email },
      { actorId },
    );
    return (await this.get(id))!;
  }

  async resetPassword(id: string, actorId: string): Promise<string> {
    const user = await this.get(id);
    if (!user) throw new NotFoundError('User', id);

    const password = this.generatePassword();
    await this.knex('users').where('id', id).update({
      password_hash: await this.auth.hashPassword(password),
      locked_until: null,
      failed_login_count: 0,
      updated_at: new Date(),
    });
    await this.audit.record(
      AuditEvent.CONFIGURATION_CHANGED,
      { change: 'PASSWORD_RESET', email: user.email },
      { actorId },
    );
    return password;
  }

  /**
   * The AGENT/bank pairing, enforced in both directions.
   *
   * An agent without a bank cannot execute anything — there is no agreement text
   * to compose from. A non-agent with a bank is worse: `banks` treats anyone
   * carrying a `bank_id` as a counterparty, so an employee with one could never
   * be designated as the countersigner, and the reason would not be obvious.
   */
  private async assertBankPairing(roles: GrantableRole[], bankId: string | null): Promise<void> {
    const isAgent = roles.includes('AGENT');

    if (isAgent && !bankId) {
      throw new ValidationError(
        'An agent must belong to a bank — that is what decides which agreement they execute.',
      );
    }
    if (!isAgent && bankId) {
      throw new ValidationError(
        'Only agents belong to a bank. GTIDS staff — administrators, employees, the MD, auditors — belong to none.',
      );
    }
    if (isAgent && roles.length > 1) {
      throw new ValidationError(
        'An agent is the counterparty, so they cannot also hold a GTIDS role. Both signatures would otherwise sit on the same side of the agreement.',
      );
    }
    if (bankId) {
      const bank = await this.knex('banks').where('id', bankId).first();
      if (!bank) throw new NotFoundError('Bank', bankId);
      if (!bank.is_active) throw new ValidationError(`Bank ${bank.name} is not active`);
    }
  }

  /** Nobody may remove the last account that can administer the system. */
  private async assertNotLastAdministrator(id: string): Promise<void> {
    const [{ count }] = await this.knex('users as u')
      .join('user_roles as ur', 'ur.user_id', 'u.id')
      .join('roles as r', 'r.id', 'ur.role_id')
      .whereIn('r.code', ['SUPER_ADMIN', 'AGREEMENT_ADMIN'])
      .where('u.is_active', true)
      .whereNot('u.id', id)
      .countDistinct<{ count: string }[]>('u.id as count');

    if (Number(count) === 0) {
      throw new ConflictError(
        'This is the last active administrator. Deactivating it would leave nobody able to administer the system.',
        'DEC-034',
      );
    }
  }

  /**
   * A designated countersigner cannot be deactivated while banks depend on them.
   *
   * Otherwise every agreement at those banks fails at creation, and the message
   * names a missing designation rather than the deactivation that caused it.
   */
  private async assertNotADesignatedSigner(id: string, name: string): Promise<void> {
    const banks = await this.knex('banks')
      .where('employee_signer_user_id', id)
      .where('is_active', true)
      .pluck('name');

    if (banks.length > 0) {
      throw new ConflictError(
        `${name} is the designated countersigner for ${banks.join(', ')}. Designate someone else for ${banks.length === 1 ? 'that bank' : 'those banks'} first.`,
        'DEC-034',
      );
    }
  }

  /**
   * A password an administrator can read out once over the phone.
   *
   * Hyphenated groups of unambiguous characters: no O/0, I/l/1, so it survives
   * being read aloud or copied off a screen, which is how these actually travel.
   */
  private generatePassword(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const pick = (n: number) =>
      Array.from(randomBytes(n))
        .map((b) => alphabet[b % alphabet.length])
        .join('');
    return `${pick(5)}-${pick(5)}-${pick(5)}`;
  }
}

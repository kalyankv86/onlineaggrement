import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import * as bcrypt from 'bcryptjs';
import { KNEX, Db } from '../common/database/database.module';
import { AuditService, AuditEvent } from '../audit/audit.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors/domain.errors';
import { generatePartyAccessToken, sha256 } from '../common/util/crypto.util';
import { Role } from '../workflow/state-machine';

export interface Principal {
  userId: string;
  email: string;
  fullName: string;
  roles: Role[];
  /** Set for external party sessions: access is scoped to this agreement only. */
  scopedAgreementId?: string;
  scopedPartyId?: string;
}

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** FR-001 — internal user login with lockout on repeated failure. */
  async login(
    email: string,
    password: string,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<{ accessToken: string; principal: Principal }> {
    const user = await this.knex('users').where('email', email).first();

    // Same message and comparable cost for "no such user" and "wrong password",
    // so login cannot be used to enumerate accounts.
    const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
    const passwordOk = await bcrypt.compare(password, hash);

    if (!user || !passwordOk || !user.is_active) {
      if (user) await this.registerFailure(user, ctx);
      await this.audit.record(AuditEvent.LOGIN_FAILED, { email }, { ...ctx });
      throw new ForbiddenError('Invalid credentials');
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new ForbiddenError(
        `Account locked until ${new Date(user.locked_until).toISOString()}`,
      );
    }

    if (user.user_type === 'EXTERNAL') {
      throw new ForbiddenError('External parties access agreements by link, not by password');
    }

    await this.knex('users')
      .where('id', user.id)
      .update({ failed_login_count: 0, locked_until: null, last_login_at: new Date() });

    const principal = await this.principalFor(user.id);
    await this.audit.record(AuditEvent.LOGIN_SUCCEEDED, { email }, { actorId: user.id, ...ctx });

    return { accessToken: await this.issueToken(principal), principal };
  }

  private async registerFailure(
    user: { id: string; failed_login_count: number },
    ctx: { ipAddress?: string },
  ): Promise<void> {
    const count = user.failed_login_count + 1;
    await this.knex('users')
      .where('id', user.id)
      .update({
        failed_login_count: count,
        locked_until:
          count >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      });
  }

  async issueToken(principal: Principal): Promise<string> {
    return this.jwt.signAsync(principal, {
      secret: this.config.get<string>('auth.jwtSecret'),
      expiresIn: principal.scopedAgreementId
        ? '2h'
        : this.config.get<string>('auth.accessTtl') ?? '30m',
    });
  }

  async verifyToken(token: string): Promise<Principal> {
    return this.jwt.verifyAsync<Principal>(token, {
      secret: this.config.get<string>('auth.jwtSecret'),
    });
  }

  async principalFor(userId: string, db: Db = this.knex): Promise<Principal> {
    const user = await db('users').where('id', userId).first();
    if (!user) throw new NotFoundError('User', userId);

    const roles = await db('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('user_roles.user_id', userId)
      .pluck<Role[]>('roles.code');

    return { userId: user.id, email: user.email, fullName: user.full_name, roles };
  }

  /**
   * Effective roles, including a time-bounded MD delegation (DEC-014). Delegation
   * is resolved at check time rather than granted as a role, so it expires without
   * anyone remembering to revoke it.
   */
  async effectiveRoles(userId: string, at: Date = new Date()): Promise<Role[]> {
    const principal = await this.principalFor(userId);
    const delegation = await this.knex('md_delegations')
      .where('delegate_user_id', userId)
      .whereNull('revoked_at')
      .where('valid_from', '<=', at)
      .where('valid_to', '>=', at)
      .first();
    return delegation && !principal.roles.includes('MD_DELEGATE')
      ? [...principal.roles, 'MD_DELEGATE']
      : principal.roles;
  }

  // ── External party access (DEC-003 / FR-001 / AC-19) ────────────────────────

  /**
   * Issue a single-use link. Only the SHA-256 of the token is stored, so a
   * database read cannot be turned into agreement access.
   */
  async issuePartyAccess(
    params: { agreementId: string; partyId: string; issuedBy: string; ipAddress?: string },
  ): Promise<{ token: string; expiresAt: Date }> {
    const party = await this.knex('agreement_parties')
      .where({ id: params.partyId, agreement_id: params.agreementId })
      .first();
    if (!party) throw new NotFoundError('Agreement party', params.partyId);

    const { token, tokenHash } = generatePartyAccessToken();
    const ttlHours = this.config.get<number>('auth.partyAccessTokenTtlHours') ?? 72;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    await this.knex('party_access_tokens').insert({
      agreement_id: params.agreementId,
      party_id: params.partyId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      issued_to_ip: params.ipAddress ?? null,
      issued_by: params.issuedBy,
    });

    await this.audit.record(
      AuditEvent.PARTY_ACCESS_ISSUED,
      { partyId: params.partyId, expiresAt },
      { agreementId: params.agreementId, actorId: params.issuedBy, ipAddress: params.ipAddress },
    );

    return { token, expiresAt };
  }

  /** Redeem a party link for a session scoped to exactly one agreement. */
  async redeemPartyAccess(
    token: string,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<{ accessToken: string; principal: Principal }> {
    const tokenHash = sha256(token);

    // Claim the token in one statement: `used_at IS NULL` in the WHERE clause makes
    // redemption atomic, so a link raced by two requests grants exactly one session.
    const claimed = await this.knex('party_access_tokens')
      .where('token_hash', tokenHash)
      .whereNull('used_at')
      .where('expires_at', '>', new Date())
      .update({ used_at: new Date() })
      .returning('*');

    if (claimed.length === 0) {
      throw new ForbiddenError('This access link is invalid, expired, or already used');
    }
    const grant = claimed[0];

    const party = await this.knex('agreement_parties').where('id', grant.party_id).first();
    if (!party) throw new NotFoundError('Agreement party', grant.party_id);

    const roleForParty: Record<string, Role> = { AGENT: 'AGENT', EMPLOYEE: 'EMPLOYEE', MD: 'MD' };
    const principal: Principal = {
      userId: party.user_id ?? `party:${party.id}`,
      email: party.email,
      fullName: party.name,
      roles: [roleForParty[party.party_type] ?? 'AUDITOR'],
      scopedAgreementId: grant.agreement_id,
      scopedPartyId: party.id,
    };

    await this.audit.record(
      AuditEvent.PARTY_ACCESS_REDEEMED,
      { partyId: party.id, partyType: party.party_type },
      { agreementId: grant.agreement_id, actorId: party.user_id ?? null, ...ctx },
    );

    return { accessToken: await this.issueToken(principal), principal };
  }

  async hashPassword(plain: string): Promise<string> {
    if (plain.length < 12) {
      throw new ValidationError('Password must be at least 12 characters');
    }
    return bcrypt.hash(plain, this.config.get<number>('auth.bcryptRounds') ?? 12);
  }
}

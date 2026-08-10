import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthService, Principal } from './auth.service';
import { Role } from '../workflow/state-machine';

export const PUBLIC_KEY = 'gtids:public';
export const ROLES_KEY = 'gtids:roles';

/** Explicitly unauthenticated — public verification and health only. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Coarse role gate. Fine-grained authority stays in the state machine. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.principal) throw new UnauthorizedException('Not authenticated');
    return req.principal;
  },
);

/** Client address for the audit trail — behind a proxy, trust the first hop only. */
export function clientContext(req: Request): { ipAddress?: string; userAgent?: string } {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ?? '').split(',')[0].trim() || req.socket?.remoteAddress;
  return { ipAddress: ip || undefined, userAgent: req.headers['user-agent'] };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token required');
    }

    try {
      req.principal = await this.auth.verifyToken(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length && !required.some((r) => req.principal!.roles.includes(r))) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }

    // An external party session is bound to one agreement (AC-19). Enforced here
    // so no controller can forget it.
    const scoped = req.principal.scopedAgreementId;
    if (scoped) {
      const requested = (req.params as Record<string, string>)?.id;
      if (requested && requested !== scoped) {
        throw new ForbiddenException('This access link is scoped to a different agreement');
      }
    }

    return true;
  }
}

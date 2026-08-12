import { cookies, headers } from 'next/headers';

export const SESSION_COOKIE = 'gtids_session';

export interface Principal {
  userId: string;
  email: string;
  fullName: string;
  roles: Role[];
  scopedAgreementId?: string;
  scopedPartyId?: string;
  effectiveRoles?: Role[];
}

export type Role =
  | 'SUPER_ADMIN'
  | 'AGREEMENT_ADMIN'
  | 'AGENT'
  | 'EMPLOYEE'
  | 'MD'
  | 'MD_DELEGATE'
  | 'AUDITOR';

/**
 * The access token lives in an httpOnly cookie and is read only on the server.
 *
 * It is never handed to client JavaScript: a bearer token in `localStorage` is
 * readable by any injected script, and this token can execute an agreement.
 * Every mutation therefore goes through a server action rather than a fetch from
 * the browser.
 */
export async function getToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Whether to mark the session cookie `Secure`.
 *
 * Derived from the actual connection, not from NODE_ENV. A `Secure` cookie sent
 * over plain HTTP is discarded by the browser silently: sign-in appears to
 * succeed, the redirect happens, and the next request arrives with no session —
 * which looks like "login does nothing" and reports no error anywhere.
 *
 * nginx sets X-Forwarded-Proto. Where it is absent (direct access in
 * development) we fall back to NODE_ENV, and never downgrade a genuinely HTTPS
 * request.
 */
async function shouldUseSecureCookie(): Promise<boolean> {
  const proto = (await headers()).get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  return process.env.NODE_ENV === 'production';
}

export async function setToken(token: string, maxAgeSeconds = 60 * 30): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: await shouldUseSecureCookie(),
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export async function clearToken(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Decode the JWT payload for display. Never used for an authorisation decision. */
export function decodePrincipal(token: string): Principal | null {
  try {
    const [, payload] = token.split('.');
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    return JSON.parse(json) as Principal;
  } catch {
    return null;
  }
}

export async function currentPrincipal(): Promise<Principal | null> {
  const token = await getToken();
  if (!token) return null;
  const principal = decodePrincipal(token);
  if (!principal) return null;
  const exp = (principal as unknown as { exp?: number }).exp;
  if (exp && exp * 1000 < Date.now()) return null;
  return principal;
}

export const hasRole = (principal: Principal | null, ...roles: Role[]): boolean =>
  !!principal && roles.some((r) => principal.roles?.includes(r));

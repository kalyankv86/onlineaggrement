import { getToken } from './session';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3100';

export interface ApiError {
  code: string;
  message: string;
  rule?: string;
  details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
  }
}

/**
 * Server-side API client. Runs only in server components and server actions, so
 * the bearer token never reaches the browser.
 *
 * Reads are uncached by default: an agreement's state changes underneath the user
 * during a signing ceremony, and a stale document hash would be rejected by the
 * API's own staleness check (FR-027) — better to always show the truth.
 */
export async function api<T = unknown>(
  route: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, ...rest } = init;
  const token = auth ? await getToken() : null;

  const res = await fetch(`${API_ORIGIN}${route}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
    cache: 'no-store',
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const error: ApiError = body?.error ?? { code: 'UNKNOWN', message: res.statusText };
    // The API returns arrays of messages for validation failures.
    if (Array.isArray(error.message)) error.message = error.message.join('; ');
    throw new ApiRequestError(res.status, error);
  }
  return body as T;
}

export const get = <T>(route: string) => api<T>(route);

export const post = <T>(route: string, body?: unknown) =>
  api<T>(route, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

export const patch = <T>(route: string, body: unknown) =>
  api<T>(route, { method: 'PATCH', body: JSON.stringify(body) });

/**
 * Pre-signed download URLs come back absolute against the API origin. Rewriting
 * them to a relative path routes them through the Next proxy, so the browser
 * stays same-origin and the API needs no CORS opening.
 */
export const proxied = (absoluteUrl: string): string =>
  absoluteUrl.startsWith(API_ORIGIN) ? absoluteUrl.slice(API_ORIGIN.length) : absoluteUrl;

// ── Domain types (mirrors docs/openapi.yaml) ─────────────────────────────────

export type AgreementStatus =
  | 'DRAFT'
  | 'READY_FOR_AGENT_SIGNATURE'
  | 'AGENT_SIGNING'
  | 'AGENT_SIGNED'
  | 'PENDING_EMPLOYEE_APPROVAL'
  | 'EMPLOYEE_APPROVING'
  | 'EMPLOYEE_APPROVED'
  | 'PENDING_MD_SIGNATURE'
  | 'MD_SIGNING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'SIGNATURE_FAILED';

export interface AgreementSummary {
  id: string;
  agreement_number: string;
  status: AgreementStatus;
  current_version: number;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export interface Party {
  id: string;
  party_type: 'AGENT' | 'EMPLOYEE' | 'MD';
  name: string;
  email: string;
  mobile: string | null;
  status: string;
  signing_order: number;
}

export interface AgreementVersion {
  version_no: number;
  signature_state: 'UNSIGNED' | 'AGENT_SIGNED' | 'EMPLOYEE_ATTESTED' | 'FINAL';
  document_hash: string;
  created_at: string;
}

export interface AgreementDetail extends AgreementSummary {
  agreement_type_id: string;
  template_version_id: string;
  data: Record<string, unknown>;
  rejected_reason: string | null;
  place_of_execution_state: string | null;
  verification_token: string | null;
  parties: Party[];
  versions: AgreementVersion[];
  stamp: { stamp_number: string; denomination: string; state_code: string } | null;
  availableActions: string[];
}

export interface SignatureVerdict {
  index: number;
  signerCommonName?: string;
  coversBytes: number;
  coversWholeFile: boolean;
  valid: boolean;
  issues: string[];
}

export interface VerificationReport {
  documentHash: string;
  signatureState: string;
  count: number;
  allValid: boolean;
  signatures: SignatureVerdict[];
}

export interface AuditEntry {
  id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  agreement_version: number | null;
  ip_address: string | null;
  created_at: string;
  actor_name: string | null;
  row_hash: string;
}

export interface StampPaper {
  id: string;
  stamp_number: string | null;
  denomination: string;
  state_code: string;
  issue_date: string | null;
  vendor: string | null;
}

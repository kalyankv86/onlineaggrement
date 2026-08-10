'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { post, patch, ApiRequestError } from '@/lib/api';
import { setToken, clearToken } from '@/lib/session';

/**
 * Every mutation is a server action.
 *
 * The bearer token lives in an httpOnly cookie, so the browser cannot make these
 * calls directly — which also means an injected script cannot sign an agreement
 * on the user's behalf. The trade is one round trip through the Next server.
 */

export interface ActionResult {
  error?: string;
  rule?: string;
  ok?: boolean;
  ceremonyUrl?: string;
  token?: string;
}

/** Turn an API refusal into something a signer can act on. */
function toResult(e: unknown): ActionResult {
  if (e instanceof ApiRequestError) {
    return { error: e.error.message, rule: e.error.rule };
  }
  if (e instanceof Error && e.message.includes('fetch failed')) {
    return { error: 'Cannot reach the agreement service. Is the API running?' };
  }
  return { error: (e as Error).message ?? 'Something went wrong' };
}

// ── Session ──────────────────────────────────────────────────────────────────

export async function login(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password' };

  try {
    const res = await post<{ accessToken: string }>('/api/v1/auth/login', { email, password });
    await setToken(res.accessToken);
  } catch (e) {
    // The API returns the same message for an unknown account and a wrong
    // password; keep it that way rather than helpfully distinguishing them.
    return toResult(e);
  }
  redirect('/agreements');
}

export async function logout(): Promise<void> {
  await clearToken();
  redirect('/login');
}

/** DEC-003 — an external party redeems a one-time link instead of signing in. */
export async function redeemPartyLink(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const token = String(form.get('token') ?? '').trim();
  if (!token) return { error: 'Paste the access token from your email' };

  let agreementId: string;
  try {
    const res = await post<{ accessToken: string; principal: { scopedAgreementId: string } }>(
      '/api/v1/auth/party-access/redeem',
      { token },
    );
    await setToken(res.accessToken, 2 * 60 * 60);
    agreementId = res.principal.scopedAgreementId;
  } catch (e) {
    return toResult(e);
  }
  redirect(`/agreements/${agreementId}`);
}

// ── Agreement lifecycle ──────────────────────────────────────────────────────

export async function createAgreement(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const variables: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith('var.')) variables[key.slice(4)] = String(value);
  }

  let id: string;
  try {
    const created = await post<{ id: string }>('/api/v1/agreements', {
      agreementTypeId: form.get('agreementTypeId'),
      templateVersionId: form.get('templateVersionId'),
      placeOfExecutionState: form.get('placeOfExecutionState') || undefined,
      data: variables,
      parties: (['AGENT', 'EMPLOYEE', 'MD'] as const).map((partyType) => ({
        partyType,
        name: String(form.get(`${partyType}.name`) ?? '').trim(),
        email: String(form.get(`${partyType}.email`) ?? '').trim(),
        mobile: String(form.get(`${partyType}.mobile`) ?? '').trim() || undefined,
      })),
    });
    id = created.id;
  } catch (e) {
    return toResult(e);
  }
  redirect(`/agreements/${id}`);
}

export async function allocateStamp(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  try {
    await post(`/api/v1/agreements/${id}/stamp`, { stampId: form.get('stampId') });
  } catch (e) {
    return toResult(e);
  }
  revalidatePath(`/agreements/${id}`);
  return { ok: true };
}

export async function generateDocument(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  try {
    await post(`/api/v1/agreements/${id}/generate`);
  } catch (e) {
    return toResult(e);
  }
  revalidatePath(`/agreements/${id}`);
  return { ok: true };
}

export async function updateDraft(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  const data: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith('var.')) data[key.slice(4)] = String(value);
  }
  try {
    await patch(`/api/v1/agreements/${id}`, { data });
  } catch (e) {
    return toResult(e);
  }
  revalidatePath(`/agreements/${id}`);
  return { ok: true };
}

// ── Signing ──────────────────────────────────────────────────────────────────

/**
 * Starts a signing ceremony and hands back the provider URL.
 *
 * `documentHash` is submitted with the request: it is the hash the signer was
 * actually shown, and the API refuses the action if the document has moved on
 * since (FR-027). The value comes from the rendered page, so a signer acting on a
 * stale tab is stopped rather than silently signing something else.
 */
export async function startSigning(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  const party = String(form.get('party')); // 'agent' | 'md'
  try {
    const res = await post<{ ceremonyUrl: string }>(`/api/v1/agreements/${id}/sign/${party}`, {
      documentHash: form.get('documentHash'),
    });
    revalidatePath(`/agreements/${id}`);
    return { ok: true, ceremonyUrl: res.ceremonyUrl };
  } catch (e) {
    return toResult(e);
  }
}

export async function approveAsEmployee(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  try {
    await post(`/api/v1/agreements/${id}/employee-approve`, {
      documentHash: form.get('documentHash'),
    });
  } catch (e) {
    return toResult(e);
  }
  revalidatePath(`/agreements/${id}`);
  return { ok: true };
}

export async function rejectAgreement(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  const reason = String(form.get('reason') ?? '').trim();
  // Mirrors the API rule so the signer is told before a round trip, not after.
  if (reason.length < 10) return { error: 'Give a reason of at least 10 characters', rule: 'FR-015' };

  try {
    await post(`/api/v1/agreements/${id}/reject`, { reason });
  } catch (e) {
    return toResult(e);
  }
  revalidatePath(`/agreements/${id}`);
  return { ok: true };
}

export async function correctAgreement(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  try {
    await post(`/api/v1/agreements/${id}/correct`);
  } catch (e) {
    return toResult(e);
  }
  revalidatePath(`/agreements/${id}`);
  return { ok: true };
}

export async function cancelAgreement(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  const reason = String(form.get('reason') ?? '').trim();
  if (reason.length < 10) return { error: 'Give a reason of at least 10 characters' };
  try {
    await post(`/api/v1/agreements/${id}/cancel`, { reason });
  } catch (e) {
    return toResult(e);
  }
  revalidatePath(`/agreements/${id}`);
  return { ok: true };
}

export async function issuePartyAccess(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const id = String(form.get('agreementId'));
  try {
    const res = await post<{ token: string; expiresAt: string }>(
      `/api/v1/agreements/${id}/party-access`,
      { partyId: form.get('partyId') },
    );
    // Shown once. Only its hash is stored, so it cannot be retrieved again.
    return { ok: true, token: res.token };
  } catch (e) {
    return toResult(e);
  }
}

// ── Stamps ───────────────────────────────────────────────────────────────────

export async function registerStamp(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const file = form.get('scan') as File | null;
  if (!file || file.size === 0) return { error: 'Attach a scan of the stamp paper' };
  if (file.size > 10 * 1024 * 1024) return { error: 'The scan exceeds the 10 MB limit' };

  try {
    await post('/api/v1/stamps', {
      stampNumber: String(form.get('stampNumber') ?? '').trim() || undefined,
      denomination: Number(form.get('denomination') ?? 100),
      stateCode: form.get('stateCode'),
      issueDate: String(form.get('issueDate') ?? '') || undefined,
      vendor: String(form.get('vendor') ?? '').trim() || undefined,
      scanBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
      scanContentType: file.type || 'application/pdf',
    });
  } catch (e) {
    return toResult(e);
  }
  revalidatePath('/stamps');
  return { ok: true };
}

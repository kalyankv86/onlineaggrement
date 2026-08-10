import { createHash, randomBytes, timingSafeEqual, createHmac } from 'crypto';

/** SHA-256 hex — the document integrity primitive throughout (FR-010). */
export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/**
 * Public verification token (DEC-006). Random rather than derived: an agreement
 * number is sequential and guessable, this is not.
 *
 * 32 characters over a 32-symbol alphabet — 160 bits of entropy. The length is
 * fixed at 32 because both the `agreements.verification_token` column and the
 * public route's format check depend on it; changing it means changing all three.
 * The alphabet omits I, L, O and U so a token can be read aloud or copied off a
 * printed QR without transcription errors. 256 is a multiple of 32, so the modulo
 * introduces no bias.
 */
export const VERIFICATION_TOKEN_LENGTH = 32;

export function generateVerificationToken(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  const bytes = randomBytes(VERIFICATION_TOKEN_LENGTH);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Opaque single-use party access token (DEC-003). Only its hash is stored. */
export function generatePartyAccessToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256(token) };
}

/** Constant-time string comparison that does not leak length through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still burn a comparison so the failure path costs the same.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** HMAC-SHA256 over the raw request body — provider callback authentication (DEC-010). */
export const hmacSha256 = (secret: string, payload: Buffer | string): string =>
  createHmac('sha256', secret).update(payload).digest('hex');

/**
 * Deterministic JSON for hashing. Object keys are ordered so that two logically
 * equal payloads always produce the same digest.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = walk((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  };
  return JSON.stringify(walk(value));
}

/** Mask an identity reference for storage/display — never store it in the clear. */
export function maskIdentity(reference: string): string {
  const tail = reference.slice(-4);
  return `${'X'.repeat(Math.max(0, reference.length - 4))}${tail}`;
}

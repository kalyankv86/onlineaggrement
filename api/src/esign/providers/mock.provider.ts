import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  EsignProvider,
  ProviderCapabilities,
  InitiateSigningRequest,
  InitiateSigningResult,
  ProviderStatus,
  CallbackVerification,
} from '../provider.interface';
import { signingIdentityFor, signDetached, certificateSubject } from './pkcs7';
import { hmacSha256, safeEqual } from '../../common/util/crypto.util';

interface MockTransaction {
  providerTransactionId: string;
  signerName: string;
  byteRangeDigest: string;
  status: ProviderStatus['status'];
  createdAt: Date;
  expiresAt: Date;
  completedAt?: Date;
  signature?: Buffer;
  failureCode?: string;
}

/**
 * Development / CI eSign provider — hash-based (DEC-002), so it exercises exactly
 * the code path the contracted ESP will use: GTIDS sends a digest, gets back a
 * detached PKCS#7, and embeds it locally by incremental update.
 *
 * It also enforces the callback contract (HMAC over the raw body, timestamp
 * window, event id), so callback authentication and idempotency are tested for
 * real rather than stubbed out.
 *
 * `assertProductionConfig` refuses to start production with ESIGN_PROVIDER=mock.
 */
@Injectable()
export class MockEsignProvider extends EsignProvider {
  private readonly log = new Logger(MockEsignProvider.name);
  private readonly transactions = new Map<string, MockTransaction>();
  private readonly secret: string;
  private readonly toleranceSeconds: number;
  private readonly ttlMinutes: number;

  constructor(config: ConfigService) {
    super();
    this.secret = config.get<string>('esign.callbackSecret') ?? 'dev-only-secret';
    this.toleranceSeconds = config.get<number>('esign.callbackToleranceSeconds') ?? 300;
    this.ttlMinutes = config.get<number>('esign.transactionTtlMinutes') ?? 30;
  }

  capabilities(): ProviderCapabilities {
    return {
      name: 'mock',
      mode: 'HASH',
      supportsSequentialSignatures: true,
      returnsSignedDocument: false,
    };
  }

  async initiateSigning(req: InitiateSigningRequest): Promise<InitiateSigningResult> {
    if (!req.byteRangeDigest) {
      throw new Error('HASH-mode provider requires byteRangeDigest');
    }
    if (req.document) {
      // Guards the privacy property the hash-based model exists to provide.
      throw new Error('HASH-mode provider must not be sent the document');
    }

    const providerTransactionId = `MOCK-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);
    this.transactions.set(providerTransactionId, {
      providerTransactionId,
      signerName: req.signer.name,
      byteRangeDigest: req.byteRangeDigest,
      status: 'PENDING_SIGNER',
      createdAt: new Date(),
      expiresAt,
    });

    return {
      providerTransactionId,
      ceremonyUrl: `${req.callbackUrl.replace('/callback', '')}/mock-ceremony/${providerTransactionId}`,
      expiresAt,
    };
  }

  async getStatus(providerTransactionId: string): Promise<ProviderStatus> {
    const tx = this.transactions.get(providerTransactionId);
    if (!tx) return { providerTransactionId, status: 'FAILED', failureCode: 'UNKNOWN_TRANSACTION' };

    if (tx.status === 'PENDING_SIGNER' && tx.expiresAt < new Date()) {
      tx.status = 'EXPIRED';
      tx.failureCode = 'CEREMONY_TIMEOUT';
    }

    const identity = signingIdentityFor(tx.signerName);
    const cert = certificateSubject(identity);
    return {
      providerTransactionId,
      status: tx.status,
      failureCode: tx.failureCode,
      completedAt: tx.completedAt,
      ...(tx.status === 'SIGNED' ? { signerCertSubject: cert.subject, signerCertSerial: cert.serial } : {}),
    };
  }

  verifyCallback(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): CallbackVerification {
    const header = (n: string) => {
      const v = headers[n] ?? headers[n.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    const signature = header('x-gtids-signature');
    const timestamp = header('x-gtids-timestamp');
    const eventId = header('x-gtids-event-id');

    if (!signature || !timestamp || !eventId) {
      return { valid: false, reason: 'missing signature, timestamp or event id header' };
    }

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > this.toleranceSeconds) {
      return { valid: false, reason: `timestamp outside ±${this.toleranceSeconds}s window` };
    }

    // Sign over timestamp + raw body so a captured signature cannot be replayed
    // against different content or at a different time.
    const expected = hmacSha256(this.secret, Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]));
    if (!safeEqual(expected, signature)) {
      return { valid: false, reason: 'signature mismatch' };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { valid: false, reason: 'body is not valid JSON' };
    }

    const providerTransactionId = String(payload.transactionId ?? '');
    const status = String(payload.status ?? '') as ProviderStatus['status'];
    if (!providerTransactionId || !status) {
      return { valid: false, reason: 'payload missing transactionId or status' };
    }

    return {
      valid: true,
      event: {
        providerEventId: eventId,
        providerTransactionId,
        status,
        failureCode: payload.failureCode ? String(payload.failureCode) : undefined,
        payload,
      },
    };
  }

  async getSignature(providerTransactionId: string): Promise<Buffer> {
    const tx = this.transactions.get(providerTransactionId);
    if (!tx) throw new Error(`unknown transaction ${providerTransactionId}`);
    if (tx.status !== 'SIGNED' || !tx.signature) {
      throw new Error(`transaction ${providerTransactionId} is ${tx.status}, not SIGNED`);
    }
    return tx.signature;
  }

  async getSignedDocument(): Promise<Buffer> {
    throw new Error('mock provider is HASH mode and does not return signed documents');
  }

  async validateTransaction(providerTransactionId: string): Promise<boolean> {
    return this.transactions.has(providerTransactionId);
  }

  // ── Test/demo affordances. Not part of EsignProvider; only the mock has them. ──

  /**
   * Stand in for the signer completing the Aadhaar OTP ceremony. `content` is the
   * ByteRange bytes GTIDS is about to embed into — a real ESP signs the digest it
   * was given, so the mock verifies the digest matches before signing.
   */
  completeCeremony(providerTransactionId: string, content: Buffer, expectedDigest: string): void {
    const tx = this.transactions.get(providerTransactionId);
    if (!tx) throw new Error(`unknown transaction ${providerTransactionId}`);
    if (tx.byteRangeDigest !== expectedDigest) {
      throw new Error('digest presented at signing does not match the digest registered');
    }
    tx.signature = signDetached(content, signingIdentityFor(tx.signerName));
    tx.status = 'SIGNED';
    tx.completedAt = new Date();
  }

  failCeremony(providerTransactionId: string, failureCode = 'OTP_MISMATCH'): void {
    const tx = this.transactions.get(providerTransactionId);
    if (!tx) throw new Error(`unknown transaction ${providerTransactionId}`);
    tx.status = 'FAILED';
    tx.failureCode = failureCode;
  }

  /** Build headers a genuine provider callback would carry. */
  signCallbackHeaders(body: Buffer, eventId: string = randomUUID()): Record<string, string> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      'x-gtids-signature': hmacSha256(this.secret, Buffer.concat([Buffer.from(`${timestamp}.`), body])),
      'x-gtids-timestamp': timestamp,
      'x-gtids-event-id': eventId,
      'content-type': 'application/json',
    };
  }
}

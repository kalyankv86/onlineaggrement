/**
 * The eSign provider boundary — SDD §20 and SDD v1.1 §B7.
 *
 * NORMATIVE CONSTRAINT: no module outside `src/esign/providers/` may reference a
 * provider name, a provider-specific field, or a provider error code. The workflow
 * module consumes only the domain types declared here. A unit test enforces this by
 * grepping the source tree — the whole point of GTIDS owning the platform is that
 * the provider can be replaced without touching the agreement engine.
 */

export type SigningMode = 'HASH' | 'DOCUMENT';

export interface ProviderCapabilities {
  name: string;
  /**
   * HASH — GTIDS computes the ByteRange digest, sends only that, and embeds the
   *        returned PKCS#7 locally. This is the CCA eSign 2.1 norm and the model
   *        that satisfies DEC-001 cleanly, because GTIDS keeps control of the
   *        incremental update.
   * DOCUMENT — the provider hosts the ceremony and returns a signed file. Usable
   *        only if the provider preserves prior signatures across sequential
   *        signing; confirm before contracting (DEC-002).
   */
  mode: SigningMode;
  supportsSequentialSignatures: boolean;
  returnsSignedDocument: boolean;
}

export interface SignerDetails {
  name: string;
  email: string;
  mobile?: string;
  /** Masked reference only — never a full Aadhaar number (SRS §12). */
  identityReference?: string;
}

export interface InitiateSigningRequest {
  agreementNumber: string;
  agreementId: string;
  partyId: string;
  signer: SignerDetails;
  /** HASH mode: the ByteRange digest. DOCUMENT mode: ignored. */
  byteRangeDigest?: string;
  /** DOCUMENT mode: the document to be signed. HASH mode: never sent. */
  document?: Buffer;
  reason: string;
  location: string;
  callbackUrl: string;
}

export interface InitiateSigningResult {
  providerTransactionId: string;
  /** Where to send the signer to complete the Aadhaar OTP ceremony. */
  ceremonyUrl: string;
  expiresAt: Date;
}

export type ProviderTransactionStatus =
  | 'INITIATED'
  | 'PENDING_SIGNER'
  | 'SIGNED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface ProviderStatus {
  providerTransactionId: string;
  status: ProviderTransactionStatus;
  failureCode?: string;
  signerCertSubject?: string;
  signerCertSerial?: string;
  completedAt?: Date;
}

/** A callback whose authenticity has been established. */
export interface VerifiedCallback {
  providerEventId: string;
  providerTransactionId: string;
  status: ProviderTransactionStatus;
  failureCode?: string;
  payload: Record<string, unknown>;
}

export interface CallbackVerification {
  valid: boolean;
  reason?: string;
  event?: VerifiedCallback;
}

export abstract class EsignProvider {
  abstract capabilities(): ProviderCapabilities;

  abstract initiateSigning(req: InitiateSigningRequest): Promise<InitiateSigningResult>;

  abstract getStatus(providerTransactionId: string): Promise<ProviderStatus>;

  /**
   * Authenticate a callback BEFORE any parsing of its contents: signature over the
   * raw body, timestamp window, event id (DEC-010 / FR-023).
   */
  abstract verifyCallback(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): CallbackVerification;

  /** HASH mode: the detached PKCS#7 to embed in the reserved /Contents gap. */
  abstract getSignature(providerTransactionId: string): Promise<Buffer>;

  /** DOCUMENT mode only. */
  abstract getSignedDocument(providerTransactionId: string): Promise<Buffer>;

  abstract validateTransaction(providerTransactionId: string): Promise<boolean>;
}

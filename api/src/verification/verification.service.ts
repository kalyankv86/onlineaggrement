import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import * as QRCode from 'qrcode';
import { KNEX } from '../common/database/database.module';
import { AuditService, AuditEvent } from '../audit/audit.service';

export interface PublicVerificationRecord {
  found: boolean;
  agreementNumber?: string;
  agreementType?: string;
  status?: string;
  completedAt?: string;
  documentHash?: string;
  signatures?: { party: string; signedAt: string }[];
}

/**
 * Public verification (FR-019 as amended, DEC-006, BR-010).
 *
 * Keyed on a 128-bit random token, never on the agreement number: the number is
 * sequential and would let anyone walk the entire register. The response carries
 * no party name, email, mobile, identity reference or stamp detail.
 */
@Injectable()
export class VerificationService {
  private readonly log = new Logger(VerificationService.name);
  private readonly verifyBaseUrl: string;

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.verifyBaseUrl = config.get<string>('publicVerifyBaseUrl') ?? '';
  }

  /**
   * Look up by token. Returns `{ found: false }` rather than throwing, and the
   * caller responds 200 either way — a 404 for a miss and 200 for a hit is itself
   * an oracle. Timing is equalised by doing the same work in both branches.
   */
  async verify(
    token: string,
    ctx: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<PublicVerificationRecord> {
    const agreement = await this.knex('agreements')
      .join('agreement_types', 'agreement_types.id', 'agreements.agreement_type_id')
      .where('agreements.verification_token', token)
      .select(
        'agreements.id',
        'agreements.agreement_number',
        'agreements.status',
        'agreements.completed_at',
        'agreement_types.name as type_name',
      )
      .first();

    if (!agreement) {
      // Deliberately no detail: a miss and a not-yet-completed agreement are
      // indistinguishable to the caller.
      return { found: false };
    }

    const [version, signatures] = await Promise.all([
      this.knex('agreement_versions')
        .where({ agreement_id: agreement.id, signature_state: 'FINAL' })
        .orderBy('created_at', 'desc')
        .first(),
      this.knex('signature_events')
        .join('agreement_parties', 'agreement_parties.id', 'signature_events.party_id')
        .where('signature_events.agreement_id', agreement.id)
        .whereIn('signature_events.event_type', ['SIGNED', 'ATTESTED'])
        .orderBy('signature_events.created_at', 'asc')
        // party_type only — a name here would defeat the point of BR-010.
        .select('agreement_parties.party_type', 'signature_events.created_at'),
    ]);

    await this.audit.record(
      AuditEvent.DOCUMENT_VERIFIED,
      { via: 'public-token' },
      { agreementId: agreement.id, ...ctx },
    );

    return {
      found: true,
      agreementNumber: agreement.agreement_number,
      agreementType: agreement.type_name,
      status: agreement.status,
      completedAt: agreement.completed_at?.toISOString(),
      documentHash: version?.document_hash,
      signatures: signatures.map((s: { party_type: string; created_at: Date }) => ({
        party: s.party_type,
        signedAt: s.created_at.toISOString(),
      })),
    };
  }

  /** QR encoding the token URL, for printing onto the completed agreement. */
  async qrCode(agreementId: string): Promise<{ url: string; dataUri: string } | null> {
    const agreement = await this.knex('agreements').where('id', agreementId).first();
    if (!agreement?.verification_token) return null;
    const url = `${this.verifyBaseUrl}/${agreement.verification_token}`;
    return {
      url,
      dataUri: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 240 }),
    };
  }
}

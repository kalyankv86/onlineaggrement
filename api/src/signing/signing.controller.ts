import { Body, Controller, Post, Param, Req, HttpCode, Logger } from '@nestjs/common';
import { IsString, Length, MinLength } from 'class-validator';
import { Request } from 'express';
import { SigningService } from './signing.service';
import { EsignService } from '../esign/esign.service';
import { CurrentUser, Public, clientContext } from '../auth/auth.guard';
import { Principal } from '../auth/auth.service';

class SignInitiateDto {
  /** FR-027 — the hash the actor was shown; a mismatch aborts the action. */
  @IsString() @Length(64, 64) documentHash!: string;
}

class RejectDto {
  @IsString() @MinLength(10, { message: 'reason must be at least 10 characters' })
  reason!: string;
}

@Controller('api/v1')
export class SigningController {
  private readonly log = new Logger(SigningController.name);

  constructor(
    private readonly signing: SigningService,
    private readonly esign: EsignService,
  ) {}

  @Post('agreements/:id/sign/agent')
  async initiateAgentSignature(
    @Param('id') id: string,
    @Body() dto: SignInitiateDto,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ) {
    return this.signing.initiateSignature(
      { agreementId: id, party: 'AGENT', presentedDocumentHash: dto.documentHash, actor },
      clientContext(req),
    );
  }

  @Post('agreements/:id/sign/md')
  async initiateMdSignature(
    @Param('id') id: string,
    @Body() dto: SignInitiateDto,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ) {
    return this.signing.initiateSignature(
      { agreementId: id, party: 'MD', presentedDocumentHash: dto.documentHash, actor },
      clientContext(req),
    );
  }

  @Post('agreements/:id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectDto,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ) {
    await this.signing.reject({ agreementId: id, reason: dto.reason, actor }, clientContext(req));
    return { status: 'REJECTED' };
  }

  /**
   * Provider callback — DEC-010 / FR-023.
   *
   * Public because the caller is the ESP, not a GTIDS principal; authentication is
   * the provider signature over the raw body, checked inside `ingestCallback`
   * before anything is parsed. Always answers 200: a provider that receives a 5xx
   * retries forever, and the idempotency ledger already makes retries harmless.
   */
  @Public()
  @Post('esign/callback')
  @HttpCode(200)
  async callback(@Req() req: Request & { rawBody?: Buffer }) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const result = await this.esign.ingestCallback(raw, req.headers);

    if (result.outcome === 'APPLIED' && result.transaction && result.event) {
      const ctx = clientContext(req);
      // Dispatched, not awaited: the provider gets a prompt acknowledgement, and
      // failures surface through the reconciliation job rather than a retry storm.
      void this.applyOutcome(result.transaction.id, result.event.status, result.event.failureCode, ctx);
    }

    return { received: true, outcome: result.outcome };
  }

  private async applyOutcome(
    transactionId: string,
    status: string,
    failureCode: string | undefined,
    ctx: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    try {
      if (status === 'SIGNED') {
        await this.signing.completeSignature(transactionId, ctx);
      } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(status)) {
        await this.signing.failSignature(transactionId, failureCode ?? status, ctx);
      }
    } catch (e) {
      this.log.error(
        `callback processing failed for transaction ${transactionId}: ${(e as Error).message}`,
      );
    }
  }
}

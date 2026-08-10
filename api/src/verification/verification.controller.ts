import { Controller, Get, Param, Req, Res, Query, HttpCode } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { VerificationService } from './verification.service';
import { Public, clientContext } from '../auth/auth.guard';
import { FilesystemStorageDriver, StorageDriver } from '../documents/storage/storage.driver';
import { VERIFICATION_TOKEN_LENGTH } from '../common/util/crypto.util';

/** Fixed-window limiter for the public surface (DEC-006). Redis-backed in production. */
class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly perMinute: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.perMinute;
  }
}

@Controller('api/v1')
export class VerificationController {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly verification: VerificationService,
    private readonly storage: StorageDriver,
    config: ConfigService,
  ) {
    this.limiter = new RateLimiter(config.get<number>('rateLimit.verifyPerMinute') ?? 10);
  }

  /**
   * Public verification — AC-09, AC-17.
   *
   * Always 200, whether or not the token resolves. A 404 for a miss would turn
   * this endpoint into an existence oracle, and the token space is the only thing
   * standing between an anonymous caller and the agreement register.
   */
  @Public()
  @Get('verify/:token')
  @HttpCode(200)
  async verify(@Param('token') token: string, @Req() req: Request) {
    const ctx = clientContext(req);
    if (!this.limiter.allow(ctx.ipAddress ?? 'unknown')) {
      return { found: false, rateLimited: true };
    }
    // Token shape is checked before the query so a malformed probe costs nothing.
    if (!new RegExp(`^[A-Z0-9]{${VERIFICATION_TOKEN_LENGTH}}$`).test(token)) return { found: false };
    return this.verification.verify(token, ctx);
  }

  /**
   * Redeem a pre-signed download URL. The signature and expiry are verified here;
   * the object store itself is private and denies public access outright, so
   * correctness does not rest on the URL staying secret (SDD v1.1 §B8 rule 5).
   */
  @Public()
  @Get('documents/download')
  async download(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    if (!(this.storage instanceof FilesystemStorageDriver)) {
      res.status(404).json({ message: 'Not available for this storage driver' });
      return;
    }
    if (!key || !this.storage.verifySignedUrl(key, Number(expires), sig ?? '')) {
      res.status(403).json({ message: 'Download link is invalid or expired' });
      return;
    }
    const data = await this.storage.get(key);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${key.split('/').pop()}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }
}

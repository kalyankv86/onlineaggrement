import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global on purpose. Nearly every module has something it must record, and
 * threading an import through each one would make "should this be audited?" a
 * question of wiring convenience rather than of policy (SRS §10).
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

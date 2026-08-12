import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';

import { configuration } from './common/config/configuration';
import { DatabaseModule } from './common/database/database.module';
import { DomainExceptionFilter } from './common/errors/domain-exception.filter';

import { AuditModule } from './audit/audit.module';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { DocumentsModule } from './documents/documents.module';
import { EsignModule } from './esign/esign.module';
import { WorkflowService } from './workflow/workflow.service';
import { StampsService } from './stamps/stamps.service';
import { StampOcrService } from './stamps/stamp-ocr.service';
import { StampsController } from './stamps/stamps.controller';
import { AgreementsService } from './agreements/agreements.service';
import { AgreementsController } from './agreements/agreements.controller';
import { TemplatesService } from './templates/templates.service';
import { TemplatesController } from './templates/templates.controller';
import { SigningService } from './signing/signing.service';
import { SigningController } from './signing/signing.controller';
import { MockCeremonyController } from './esign/providers/mock-ceremony.controller';
import { NotificationsService } from './notifications/notifications.service';
import { VerificationService } from './verification/verification.service';
import { VerificationController } from './verification/verification.controller';
import { ReportsService } from './reports/reports.service';
import { ReportsController } from './reports/reports.controller';
import { ScheduledJobsService } from './jobs/scheduled-jobs.service';
import { HealthController } from './health/health.controller';

/**
 * One module. The SDD's module list (§3) is expressed as directories and services
 * rather than Nest modules — at this size, a module per concern would add wiring
 * without adding a boundary. The boundaries that matter are enforced elsewhere:
 * the eSign provider behind its adapter, the renderer and storage behind theirs,
 * and `agreements.status` behind the workflow service.
 *
 * `RUN_SCHEDULER` keeps the jobs out of the API process. In production they run in
 * the separate worker (SDD §14) so that a Chromium render cannot starve the API.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    DatabaseModule,
    AuditModule,
    JwtModule.register({}),
    ...(process.env.RUN_SCHEDULER === 'true' ? [ScheduleModule.forRoot()] : []),
    DocumentsModule,
    EsignModule,
  ],
  controllers: [
    AuthController,
    AgreementsController,
    TemplatesController,
    StampsController,
    SigningController,
    // Refuses unless ESIGN_PROVIDER=mock, which production cannot be.
    MockCeremonyController,
    VerificationController,
    ReportsController,
    HealthController,
  ],
  providers: [
    AuthService,
    WorkflowService,
    StampsService,
    StampOcrService,
    AgreementsService,
    TemplatesService,
    SigningService,
    NotificationsService,
    VerificationService,
    ReportsService,
    ...(process.env.RUN_SCHEDULER === 'true' ? [ScheduledJobsService] : []),
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
  exports: [WorkflowService, SigningService, NotificationsService],
})
export class AppModule {}

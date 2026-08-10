import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.guard';

/** FR-020 — management and operational reporting. Read-only, admin/auditor scoped. */
@Controller('api/v1/reports')
@Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN', 'AUDITOR', 'MD')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  @Get('agreements')
  agreements(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.agreementSummary(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get('workflow-aging')
  aging() {
    return this.reports.workflowAging();
  }

  @Get('signatures')
  signatures(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.signatureReport(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get('stamps')
  stamps() {
    return this.reports.stampReport();
  }

  @Get('notifications')
  notifications() {
    return this.reports.notificationReport();
  }

  /** FR-025 — audit chain integrity across the whole register. */
  @Get('audit-integrity')
  auditIntegrity() {
    return this.reports.auditIntegritySummary();
  }

  @Get('audit-chain')
  chain(@Query('agreementId') agreementId?: string) {
    return this.audit.verifyChain(agreementId ?? null);
  }
}

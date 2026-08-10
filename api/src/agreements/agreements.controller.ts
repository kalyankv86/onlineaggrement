import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  HttpCode,
} from '@nestjs/common';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { AgreementsService } from './agreements.service';
import { WorkflowService } from '../workflow/workflow.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DocumentsService } from '../documents/documents.service';
import { VerificationService } from '../verification/verification.service';
import { CurrentUser, Roles, clientContext } from '../auth/auth.guard';
import { Principal } from '../auth/auth.service';

class PartyDto {
  @IsIn(['AGENT', 'EMPLOYEE', 'MD']) partyType!: 'AGENT' | 'EMPLOYEE' | 'MD';
  @IsOptional() @IsUUID() userId?: string;
  @IsString() @Length(2, 200) name!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsString() identityReference?: string;
}

class CreateAgreementDto {
  @IsUUID() agreementTypeId!: string;
  @IsUUID() templateVersionId!: string;
  @IsOptional() @IsString() placeOfExecutionState?: string;
  /**
   * Template variable values. Shape is not fixed here — it is validated against
   * the template version's own `variables_schema` in the service, which is where
   * the requirement actually lives (FR-003).
   */
  @IsObject() data!: Record<string, unknown>;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PartyDto) parties!: PartyDto[];
}

class UpdateAgreementDto {
  @IsOptional() @IsObject() data?: Record<string, unknown>;
  @IsOptional() @IsString() placeOfExecutionState?: string;
}

class AllocateStampDto {
  @IsUUID() stampId!: string;
}

class ReasonDto {
  // FR-015 / SRS v1.1 §A5 — rejection and cancellation reasons are mandatory and
  // must be substantive, not a single character.
  @IsString() @MinLength(10, { message: 'reason must be at least 10 characters' })
  reason!: string;
}

class IssuePartyAccessDto {
  @IsUUID() partyId!: string;
}

@Controller('api/v1/agreements')
export class AgreementsController {
  constructor(
    private readonly agreements: AgreementsService,
    private readonly workflow: WorkflowService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly documents: DocumentsService,
    private readonly verification: VerificationService,
  ) {}

  @Post()
  @Roles('AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async create(@Body() dto: CreateAgreementDto, @CurrentUser() actor: Principal, @Req() req: Request) {
    return this.agreements.create(dto, actor, clientContext(req));
  }

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('agreementTypeId') agreementTypeId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.agreements.list({
      status,
      agreementTypeId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() actor: Principal) {
    return this.agreements.get(id, actor);
  }

  /** FR-015a — edit a draft, including after a correction re-opened it. */
  @Patch(':id')
  @Roles('AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAgreementDto,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ) {
    return this.agreements.updateDraft(id, dto, actor, clientContext(req));
  }

  @Post(':id/stamp')
  @Roles('AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async allocateStamp(
    @Param('id') id: string,
    @Body() dto: AllocateStampDto,
    @CurrentUser() actor: Principal,
  ) {
    return this.agreements.allocateStamp(id, dto.stampId, actor);
  }

  @Post(':id/generate')
  @Roles('AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async generate(@Param('id') id: string, @CurrentUser() actor: Principal, @Req() req: Request) {
    return this.agreements.generate(id, actor, clientContext(req));
  }

  @Get(':id/document')
  async document(@Param('id') id: string, @CurrentUser() actor: Principal, @Req() req: Request) {
    return this.agreements.documentUrl(id, actor, clientContext(req));
  }

  @Get(':id/versions')
  async versions(@Param('id') id: string) {
    const agreement = await this.workflow.get(id);
    return {
      currentVersion: agreement.current_version,
      versions: await this.documents.listVersions(id),
    };
  }

  /** On-demand re-validation of every signature on the current document (SRS v1.1 §8.3). */
  @Get(':id/verify-signatures')
  async verifySignatures(@Param('id') id: string) {
    const agreement = await this.workflow.get(id);
    const version = await this.documents.currentVersion(id, agreement.current_version);
    const report = await this.documents.verifyStored(version.file_key);
    return { documentHash: version.document_hash, signatureState: version.signature_state, ...report };
  }

  @Get(':id/audit')
  @Roles('AUDITOR', 'AGREEMENT_ADMIN', 'SUPER_ADMIN', 'MD')
  async auditTrail(@Param('id') id: string) {
    return {
      entries: await this.audit.forAgreement(id),
      transitions: await this.workflow.history(id),
      chain: await this.audit.verifyChain(id),
    };
  }

  @Get(':id/qr')
  async qr(@Param('id') id: string) {
    return (await this.verification.qrCode(id)) ?? { url: null, dataUri: null };
  }

  /** FR-015a — open version N+1 on a rejected or expired agreement. */
  @Post(':id/correct')
  @Roles('AGENT', 'AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async correct(@Param('id') id: string, @CurrentUser() actor: Principal, @Req() req: Request) {
    return this.workflow.correct({
      agreementId: id,
      actorId: actor.userId,
      actorRoles: actor.roles,
      ...clientContext(req),
    });
  }

  @Post(':id/cancel')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async cancel(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ) {
    return this.workflow.transition({
      agreementId: id,
      action: 'CANCEL',
      actorId: actor.userId,
      actorRoles: actor.roles,
      trigger: 'USER',
      reason: dto.reason,
      auditContext: clientContext(req),
    });
  }

  /** DEC-003 — issue a single-use link for an external party. */
  @Post(':id/party-access')
  @HttpCode(201)
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN', 'AGENT')
  async issuePartyAccess(
    @Param('id') id: string,
    @Body() dto: IssuePartyAccessDto,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ) {
    return this.auth.issuePartyAccess({
      agreementId: id,
      partyId: dto.partyId,
      issuedBy: actor.userId,
      ipAddress: clientContext(req).ipAddress,
    });
  }
}

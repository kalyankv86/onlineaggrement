import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { BanksService } from './banks.service';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { Principal } from '../auth/auth.service';
import { ValidationError } from '../common/errors/domain.errors';

class CreateBankDto {
  @IsString() @Length(2, 20) code!: string;
  @IsString() @Length(2, 200) name!: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() @Length(0, 200) contactPerson?: string;
}

class UpdateBankDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() @Length(0, 200) contactPerson?: string;
  @IsOptional() @IsUUID() employeeSignerUserId?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UploadDocumentDto {
  @IsString() documentBase64!: string;
  @IsString() @Length(1, 300) filename!: string;
  @IsOptional() @IsString() contentType?: string;
}

/**
 * Bank administration (DEC-031, DEC-032).
 *
 * Every route is restricted to administrators. An agent must not be able to
 * create a bank, change which employee countersigns, or replace the agreement
 * text their own signature will be applied to.
 */
@Controller('api/v1/banks')
export class BanksController {
  constructor(private readonly banks: BanksService) {}

  @Get()
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async list() {
    return this.banks.list();
  }

  /** Internal staff eligible to be designated as a bank's countersigner. */
  @Get('eligible-signers')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async eligibleSigners() {
    return this.banks.eligibleSigners();
  }

  @Post()
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async create(@Body() dto: CreateBankDto, @CurrentUser() actor: Principal) {
    return this.banks.create(dto, actor.userId);
  }

  @Get(':id')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async get(@Param('id') id: string) {
    return this.banks.get(id);
  }

  @Patch(':id')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBankDto,
    @CurrentUser() actor: Principal,
  ) {
    return this.banks.update(id, dto, actor.userId);
  }

  @Get(':id/documents')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async documents(@Param('id') id: string) {
    return this.banks.documentVersions(id);
  }

  @Post(':id/documents')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async uploadDocument(
    @Param('id') id: string,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() actor: Principal,
  ) {
    const buffer = Buffer.from(dto.documentBase64, 'base64');
    if (buffer.length === 0) {
      throw new ValidationError('The document is empty or not valid base64');
    }
    return this.banks.uploadDocument(
      id,
      {
        buffer,
        filename: dto.filename,
        contentType: dto.contentType ?? 'application/pdf',
      },
      actor.userId,
    );
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  IsArray, IsIn, IsISO8601, IsNumber, IsOptional, IsString, Length, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StampsService } from './stamps.service';
import { StampOcrService } from './stamp-ocr.service';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { Principal } from '../auth/auth.service';
import { ValidationError } from '../common/errors/domain.errors';

class StampIdentifierDto {
  @IsIn(['CERTIFICATE_NO', 'UNIQUE_DOC_REF', 'PAPER_SERIAL', 'OTHER'])
  kind!: 'CERTIFICATE_NO' | 'UNIQUE_DOC_REF' | 'PAPER_SERIAL' | 'OTHER';
  @IsString() @Length(6, 60) value!: string;
}

class RegisterStampDto {
  @IsOptional() @IsString() @Length(1, 100) stampNumber?: string;
  /** All identifiers printed on the paper; each is independently unique. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => StampIdentifierDto)
  identifiers?: StampIdentifierDto[];
  @IsOptional() @IsString() issuer?: string;
  @IsOptional() @IsString() accountReference?: string;
  @IsOptional() @IsString() ddoCode?: string;
  @IsOptional() @IsString() documentDescription?: string;
  @IsOptional() @IsString() propertyDescription?: string;
  @IsOptional() @IsNumber() considerationPrice?: number;
  @IsOptional() @IsString() firstParty?: string;
  @IsOptional() @IsString() secondParty?: string;
  @IsNumber() denomination!: number;
  @IsString() @Length(2, 10) stateCode!: string;
  @IsOptional() @IsISO8601() issueDate?: string;
  @IsOptional() @IsString() vendor?: string;
  /** Base64 scan of the physical stamp paper (FR-005). */
  @IsString() scanBase64!: string;
  @IsOptional() @IsString() scanContentType?: string;
}

class OcrStampDto {
  @IsString() scanBase64!: string;
  @IsOptional() @IsString() scanContentType?: string;
}

const MAX_SCAN_BYTES = 10 * 1024 * 1024; // SRS v1.1 §11 hard limit

@Controller('api/v1/stamps')
export class StampsController {
  constructor(
    private readonly stamps: StampsService,
    private readonly ocr: StampOcrService,
  ) {}

  /**
   * DEC-026 — read a stamp scan and propose the fields.
   *
   * Deliberately creates nothing. A misread stamp number would become the legal
   * identifier of the instrument and is the value BR-006 uniqueness is enforced
   * on, so the result is a proposal an operator confirms.
   */
  @Post('ocr')
  @HttpCode(200)
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN', 'AGENT')
  async readStamp(@Body() dto: OcrStampDto) {
    const scan = Buffer.from(dto.scanBase64, 'base64');
    if (scan.length === 0) throw new ValidationError('Stamp scan is empty or not valid base64');
    if (scan.length > MAX_SCAN_BYTES) {
      throw new ValidationError(`Stamp scan exceeds the ${MAX_SCAN_BYTES / 1024 / 1024} MB limit`);
    }
    const reading = await this.ocr.read(scan, dto.scanContentType ?? 'application/pdf');
    return { ...reading, requiresConfirmation: true };
  }

  @Post()
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async register(@Body() dto: RegisterStampDto, @CurrentUser() actor: Principal) {
    const scan = Buffer.from(dto.scanBase64, 'base64');
    if (scan.length === 0) throw new ValidationError('Stamp scan is empty or not valid base64');
    if (scan.length > MAX_SCAN_BYTES) {
      throw new ValidationError(`Stamp scan exceeds the ${MAX_SCAN_BYTES / 1024 / 1024} MB limit`);
    }

    return this.stamps.register(
      {
        stampNumber: dto.stampNumber,
        identifiers: dto.identifiers,
        denomination: dto.denomination,
        stateCode: dto.stateCode,
        issueDate: dto.issueDate,
        vendor: dto.vendor,
        issuer: dto.issuer,
        accountReference: dto.accountReference,
        ddoCode: dto.ddoCode,
        documentDescription: dto.documentDescription,
        propertyDescription: dto.propertyDescription,
        considerationPrice: dto.considerationPrice,
        firstParty: dto.firstParty,
        secondParty: dto.secondParty,
        scan,
        scanContentType: dto.scanContentType ?? 'application/pdf',
      },
      actor.userId,
    );
  }

  @Get('available')
  available(@Query('denomination') denomination = '100', @Query('stateCode') stateCode?: string) {
    return this.stamps.findAvailable(Number(denomination), stateCode);
  }

  @Get('report')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN', 'AUDITOR')
  report() {
    return this.stamps.inventoryReport();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.stamps.get(id);
  }
}

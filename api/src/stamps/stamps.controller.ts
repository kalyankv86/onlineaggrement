import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsISO8601, IsNumber, IsOptional, IsString, Length } from 'class-validator';
import { StampsService } from './stamps.service';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { Principal } from '../auth/auth.service';
import { ValidationError } from '../common/errors/domain.errors';

class RegisterStampDto {
  @IsOptional() @IsString() @Length(1, 100) stampNumber?: string;
  @IsNumber() denomination!: number;
  @IsString() @Length(2, 10) stateCode!: string;
  @IsOptional() @IsISO8601() issueDate?: string;
  @IsOptional() @IsString() vendor?: string;
  /** Base64 scan of the physical stamp paper (FR-005). */
  @IsString() scanBase64!: string;
  @IsOptional() @IsString() scanContentType?: string;
}

const MAX_SCAN_BYTES = 10 * 1024 * 1024; // SRS v1.1 §11 hard limit

@Controller('api/v1/stamps')
export class StampsController {
  constructor(private readonly stamps: StampsService) {}

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
        denomination: dto.denomination,
        stateCode: dto.stateCode,
        issueDate: dto.issueDate,
        vendor: dto.vendor,
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

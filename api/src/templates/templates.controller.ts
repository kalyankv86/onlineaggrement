import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { TemplatesService } from './templates.service';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { Principal } from '../auth/auth.service';

class CreateTemplateDto {
  @IsUUID() agreementTypeId!: string;
  @IsString() @Length(2, 200) name!: string;
  @IsOptional() @IsString() description?: string;
}

class CreateVersionDto {
  @IsString() @Length(1, 500_000) content!: string;
  @IsOptional() @IsObject() variablesSchema?: { required?: string[] };
}

@Controller('api/v1/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get('types')
  listTypes() {
    return this.templates.listTypes();
  }

  @Get()
  list(@Query('agreementTypeId') agreementTypeId?: string) {
    return this.templates.listTemplates(agreementTypeId);
  }

  @Post()
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  create(@Body() dto: CreateTemplateDto) {
    return this.templates.createTemplate(dto);
  }

  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.templates.listVersions(id);
  }

  @Post(':id/versions')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  createVersion(
    @Param('id') id: string,
    @Body() dto: CreateVersionDto,
    @CurrentUser() actor: Principal,
  ) {
    return this.templates.createVersion({
      templateId: id,
      content: dto.content,
      variablesSchema: dto.variablesSchema,
      createdBy: actor.userId,
    });
  }

  @Post('versions/:versionId/approve')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  approve(@Param('versionId') versionId: string, @CurrentUser() actor: Principal) {
    return this.templates.approveVersion(versionId, actor.userId);
  }

  @Post('versions/:versionId/retire')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  retire(@Param('versionId') versionId: string) {
    return this.templates.retireVersion(versionId);
  }

  @Post('versions/:versionId/preview')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  preview(@Param('versionId') versionId: string, @Body() variables: Record<string, unknown>) {
    return this.templates.preview(versionId, variables);
  }
}

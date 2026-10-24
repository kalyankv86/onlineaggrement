import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { UsersService, GRANTABLE_ROLES, type GrantableRole } from './users.service';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { Principal } from '../auth/auth.service';
import { ForbiddenError } from '../common/errors/domain.errors';

class UpsertUserDto {
  @IsEmail() email!: string;
  @IsString() @Length(2, 200) fullName!: string;
  @IsOptional() @IsString() @Length(0, 20) mobile?: string;
  @IsArray() @ArrayNotEmpty() @IsIn(GRANTABLE_ROLES, { each: true }) roles!: GrantableRole[];
  /** Required for an agent, refused for anyone else (DEC-031). */
  @IsOptional() @IsUUID() bankId?: string;
  /** Omit to have one generated and shown once. */
  @IsOptional() @IsString() @Length(12, 200) password?: string;
}

class SetActiveDto {
  @IsBoolean() isActive!: boolean;
}

/**
 * User administration.
 *
 * Creating users is a SUPER_ADMIN action, not AGREEMENT_ADMIN: granting roles is
 * granting authority, including the authority to grant roles. Listing is open to
 * both, so an agreement administrator can see who holds what without being able
 * to change it.
 */
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async list() {
    return this.users.list();
  }

  @Get('grantable-roles')
  @Roles('AGREEMENT_ADMIN', 'SUPER_ADMIN')
  async grantableRoles() {
    return GRANTABLE_ROLES;
  }

  @Post()
  @Roles('SUPER_ADMIN')
  async upsert(@Body() dto: UpsertUserDto, @CurrentUser() actor: Principal) {
    return this.users.upsert(
      {
        email: dto.email,
        fullName: dto.fullName,
        mobile: dto.mobile,
        roles: dto.roles,
        bankId: dto.bankId ?? null,
        password: dto.password,
      },
      actor.userId,
    );
  }

  @Post(':id/active')
  @Roles('SUPER_ADMIN')
  async setActive(
    @Param('id') id: string,
    @Body() dto: SetActiveDto,
    @CurrentUser() actor: Principal,
  ) {
    // Locking yourself out is a support call, and the account that can fix it is
    // the one being disabled.
    if (id === actor.userId && !dto.isActive) {
      throw new ForbiddenError('You cannot deactivate your own account', 'DEC-034');
    }
    return this.users.setActive(id, dto.isActive, actor.userId);
  }

  @Post(':id/reset-password')
  @Roles('SUPER_ADMIN')
  async resetPassword(@Param('id') id: string, @CurrentUser() actor: Principal) {
    // Returned once and never stored in readable form. If it is lost, the only
    // remedy is another reset.
    return { password: await this.users.resetPassword(id, actor.userId) };
  }
}

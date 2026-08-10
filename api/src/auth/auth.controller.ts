import { Body, Controller, Get, Post, Req, HttpCode } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { Request } from 'express';
import { AuthService, Principal } from './auth.service';
import { CurrentUser, Public, clientContext } from './auth.guard';

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
}

class RedeemDto {
  @IsString() @MinLength(20) token!: string;
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, clientContext(req));
  }

  /** DEC-003 — exchange a single-use party link for a session scoped to one agreement. */
  @Public()
  @Post('party-access/redeem')
  @HttpCode(200)
  async redeem(@Body() dto: RedeemDto, @Req() req: Request) {
    return this.auth.redeemPartyAccess(dto.token, clientContext(req));
  }

  @Get('me')
  async me(@CurrentUser() actor: Principal) {
    return {
      ...actor,
      // Delegation is resolved at request time, so an expired MD delegation
      // disappears without anyone revoking a role (DEC-014).
      effectiveRoles: actor.scopedAgreementId
        ? actor.roles
        : await this.auth.effectiveRoles(actor.userId),
    };
  }
}

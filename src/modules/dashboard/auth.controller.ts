import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import {
  AllowDuringPasswordChange,
  type AuthContext,
  CurrentAuth,
  Public,
  SESSION_COOKIE,
} from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { UserError, UsersService, toPublic } from '../auth/users.service.js';

import { type AccountDto, AccountSchema, type LoginDto, LoginSchema } from './dto/auth.dto.js';

/** A refused user change as an HTTP error with its stable code. */
export function userHttpError(err: unknown): never {
  if (err instanceof UserError) {
    const status =
      err.code === 'AUTH_INVALID_CREDENTIALS' || err.code === 'AUTH_LOCKED' ? 401 : err.status;
    throw new HttpException({ message: err.message, code: err.code }, status);
  }
  throw err;
}

/** Sign-in, sign-out, the current user, and changing your own username or password. */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private cookieOptions(req: Request) {
    const secure =
      this.cfg.COOKIE_SECURE === 'true' || (this.cfg.COOKIE_SECURE === 'auto' && req.secure);
    return { httpOnly: true, sameSite: 'strict' as const, secure, path: '/' };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const s = await this.auth
      .login(body.username, body.password, {
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      })
      .catch(userHttpError);
    res.cookie(SESSION_COOKIE, s.token, {
      ...this.cookieOptions(req),
      maxAge: this.cfg.SESSION_TTL_HOURS * 3_600_000,
    });
    return { user: toPublic(s.user) };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentAuth() a: AuthContext | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(a?.token);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions(req));
    return { signedOut: true };
  }

  @AllowDuringPasswordChange()
  @Get('me')
  me(@CurrentAuth() a: AuthContext) {
    return { user: toPublic(a.user) };
  }

  @AllowDuringPasswordChange()
  @Post('account')
  @HttpCode(200)
  async account(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(AccountSchema)) body: AccountDto,
  ) {
    const user = await this.users.changeOwn(a.user.id, a.sessionId, body).catch(userHttpError);
    return { user };
  }
}

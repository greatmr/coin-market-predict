import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { assertTrustedWrite } from '../../common/security/write-guard.js';

import { AuthService } from './auth.service.js';
import type { AppUser } from './entities/app-user.entity.js';
import { type Permission, ROLE_LABELS, can } from './permissions.js';

export const SESSION_COOKIE = 'cp_session';

const PUBLIC_KEY = 'auth:public';
const PERMISSION_KEY = 'auth:permission';
const PASSWORD_CHANGE_KEY = 'auth:allow-password-change';

/** Reachable without signing in (sign-in and sign-out only). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** The permission a route needs; routes without one need `data:read`. */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);
/** Reachable while the user still has to replace a temporary password (their own account only). */
export const AllowDuringPasswordChange = () => SetMetadata(PASSWORD_CHANGE_KEY, true);

export interface AuthContext {
  user: AppUser;
  sessionId: string;
  token: string;
}
type AuthedRequest = Request & { auth?: AuthContext };

/** The signed-in user of the request (set by AuthGuard). */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().auth,
);

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Every `/api` route: writes must be same-origin JSON; then a valid session is required (unless
 * `@Public`), a pending password change blocks everything but the account routes, and the route's
 * permission is checked against the user's role. `/mcp` (bearer tokens) and `/healthz` are not
 * under `/api` and keep their own rules. Registered globally by the dashboard module.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const path = req.originalUrl.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return true;
    if (UNSAFE.has(req.method)) assertTrustedWrite(req);

    const targets = [ctx.getHandler(), ctx.getClass()];
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const found = await this.auth.userForToken(token);
    if (found && token) req.auth = { ...found, token };
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    if (!found)
      throw new UnauthorizedException({
        message: 'Sign in to continue.',
        code: ErrorCodes.AUTH_REQUIRED,
      });
    if (
      found.user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(PASSWORD_CHANGE_KEY, targets)
    )
      throw new ForbiddenException({
        message: 'Choose a new password to continue.',
        code: ErrorCodes.PASSWORD_CHANGE_REQUIRED,
      });
    const needed =
      this.reflector.getAllAndOverride<Permission>(PERMISSION_KEY, targets) ?? 'data:read';
    if (!can(found.user.role, needed))
      throw new ForbiddenException({
        message: `The ${ROLE_LABELS[found.user.role]} role can't do this.`,
        code: ErrorCodes.PERMISSION_DENIED,
      });
    return true;
  }
}

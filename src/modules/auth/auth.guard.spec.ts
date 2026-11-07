import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import {
  AllowDuringPasswordChange,
  AuthGuard,
  Public,
  RequirePermission,
  readCookie,
} from './auth.guard.js';
import type { AuthService } from './auth.service.js';
import type { AppUser } from './entities/app-user.entity.js';
import type { UserRole } from './permissions.js';

class Routes {
  @Public() login() {}
  read() {}
  @RequirePermission('users:manage') users() {}
  @AllowDuringPasswordChange() account() {}
}

const user = (role: UserRole, mustChangePassword = false) =>
  ({ id: 'u1', role, mustChangePassword, isActive: true }) as AppUser;

function run(
  handler: keyof Routes,
  opts: {
    url?: string;
    method?: string;
    cookie?: string;
    signedIn?: AppUser | null;
    json?: boolean;
    origin?: string;
  } = {},
) {
  const auth = {
    userForToken: async (t?: string) =>
      t === 'good' && opts.signedIn ? { user: opts.signedIn, sessionId: 's1' } : null,
  } as unknown as AuthService;
  const req: Record<string, unknown> = {
    originalUrl: opts.url ?? '/api/overview',
    method: opts.method ?? 'GET',
    headers: {
      cookie: opts.cookie ?? 'cp_session=good',
      host: 'dash.example',
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    is: (t: string) => ((opts.json ?? true) && t === 'application/json' ? t : false),
  };
  const ctx = {
    getType: () => 'http',
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { result: new AuthGuard(new Reflector(), auth).canActivate(ctx), req };
}

describe('dashboard auth guard', () => {
  it('reads the session cookie among others', () => {
    expect(readCookie('a=1; cp_session=abc%3D; b=2', 'cp_session')).toBe('abc=');
    expect(readCookie(undefined, 'cp_session')).toBeUndefined();
  });

  it('leaves routes outside /api to their own auth (MCP bearer tokens, liveness)', async () => {
    await expect(run('read', { url: '/mcp', signedIn: null }).result).resolves.toBe(true);
    await expect(run('read', { url: '/healthz', signedIn: null }).result).resolves.toBe(true);
  });

  it('requires a session for every /api route except sign-in', async () => {
    await expect(run('read', { signedIn: null }).result).rejects.toMatchObject({ status: 401 });
    await expect(run('login', { signedIn: null, method: 'POST' }).result).resolves.toBe(true);
    const ok = run('read', { signedIn: user('reviewer') });
    await expect(ok.result).resolves.toBe(true);
    expect((ok.req.auth as { sessionId: string }).sessionId).toBe('s1');
  });

  it("checks the route's permission against the role (data:read by default)", async () => {
    await expect(run('users', { signedIn: user('analyzer') }).result).rejects.toMatchObject({
      status: 403,
    });
    await expect(run('users', { signedIn: user('owner') }).result).resolves.toBe(true);
    await expect(run('read', { signedIn: user('reviewer') }).result).resolves.toBe(true);
  });

  it('allows only the account routes while a temporary password must be replaced', async () => {
    const pending = user('owner', true);
    await expect(run('read', { signedIn: pending }).result).rejects.toMatchObject({
      response: { code: 'PASSWORD_CHANGE_REQUIRED' },
    });
    await expect(run('account', { signedIn: pending }).result).resolves.toBe(true);
  });

  it('refuses cross-origin and non-JSON writes before anything else, sign-in included', async () => {
    await expect(
      run('login', { method: 'POST', origin: 'https://evil.example', signedIn: null }).result,
    ).rejects.toMatchObject({ response: { code: 'WRITE_FORBIDDEN' } });
    await expect(
      run('read', { method: 'POST', json: false, signedIn: user('owner') }).result,
    ).rejects.toMatchObject({
      response: { code: 'WRITE_FORBIDDEN' },
    });
  });
});

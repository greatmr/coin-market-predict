import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AppUser } from '../auth/entities/app-user.entity.js';
import type { UserRole } from '../auth/permissions.js';

import { ForwardController } from './forward.controller.js';

type Route = 'summary' | 'events' | 'event' | 'rejections' | 'download' | 'update';

/** Whether a signed-in user of `role` passes the guard for one forward-test route. */
async function allowed(role: UserRole, route: Route): Promise<boolean> {
  const auth = {
    userForToken: async () => ({
      user: { id: 'u1', role, mustChangePassword: false, isActive: true } as AppUser,
      sessionId: 's1',
    }),
  } as unknown as AuthService;
  const req = {
    originalUrl: '/api/forward',
    method: route === 'update' ? 'POST' : 'GET',
    headers: { cookie: 'cp_session=good', host: 'dash.example' },
    is: (t: string) => (t === 'application/json' ? t : false),
  };
  const ctx = {
    getType: () => 'http',
    getHandler: () => ForwardController.prototype[route],
    getClass: () => ForwardController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  try {
    return await new AuthGuard(new Reflector(), auth).canActivate(ctx);
  } catch {
    return false;
  }
}

describe('forward-test routes and roles', () => {
  it('lets every role read the star-group report, events and rejections', async () => {
    for (const role of ['owner', 'analyzer', 'reviewer'] as const)
      for (const route of ['summary', 'events', 'event', 'rejections'] as const)
        expect(await allowed(role, route), `${role} ${route}`).toBe(true);
  });

  it('keeps bulk downloads to exports:read and the manual update to scan:operate', async () => {
    expect(await allowed('reviewer', 'download')).toBe(false);
    expect(await allowed('analyzer', 'download')).toBe(true);
    expect(await allowed('reviewer', 'update')).toBe(false);
    expect(await allowed('analyzer', 'update')).toBe(true);
    expect(await allowed('owner', 'update')).toBe(true);
  });
});

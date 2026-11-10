import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AppUser } from '../auth/entities/app-user.entity.js';
import { USER_ROLES, type UserRole } from '../auth/permissions.js';
import { SettingsError } from '../settings/settings.plan.js';
import type { SettingsService } from '../settings/settings.service.js';

import { SettingsController } from './settings.controller.js';

type Route = 'view' | 'save' | 'importEnvironment' | 'history';
const METHOD: Record<Route, string> = {
  view: 'GET',
  save: 'PUT',
  importEnvironment: 'POST',
  history: 'GET',
};

async function allowed(role: UserRole, route: Route): Promise<boolean> {
  const auth = {
    userForToken: async () => ({
      user: { id: 'u1', role, mustChangePassword: false, isActive: true } as AppUser,
      sessionId: 's1',
    }),
  } as unknown as AuthService;
  const req = {
    originalUrl: '/api/settings',
    method: METHOD[route],
    headers: { cookie: 'cp_session=good', host: 'dash.example' },
    is: (t: string) => (t === 'application/json' ? t : false),
  };
  const ctx = {
    getType: () => 'http',
    getHandler: () => SettingsController.prototype[route],
    getClass: () => SettingsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  try {
    return await new AuthGuard(new Reflector(), auth).canActivate(ctx);
  } catch {
    return false;
  }
}

describe('settings routes', () => {
  it('are owner-only, reading included (the settings reveal the operation)', async () => {
    for (const role of USER_ROLES)
      for (const route of Object.keys(METHOD) as Route[])
        expect(await allowed(role, route), `${role} ${route}`).toBe(role === 'owner');
  });

  it('answer an invalid save with one error per setting', async () => {
    const service = {
      save: async () => {
        throw new SettingsError([
          { key: 'PIPELINE_CRON', message: 'is not a valid cron expression' },
          { key: 'TELEGRAM_MODE', message: 'is set in the server environment' },
        ]);
      },
    } as unknown as SettingsService;
    const owner = { user: { id: 'u1', username: 'owner' } } as never;
    try {
      await new SettingsController(service).save(owner, { values: {}, reset: [] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        errors: [
          { message: 'PIPELINE_CRON: is not a valid cron expression', code: 'SETTINGS_INVALID' },
          { message: 'TELEGRAM_MODE: is set in the server environment', code: 'SETTINGS_INVALID' },
        ],
      });
    }
  });
});

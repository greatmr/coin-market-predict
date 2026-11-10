import { describe, expect, it } from 'vitest';

import { PERMISSIONS, ROLE_PERMISSIONS, USER_ROLES, can } from './permissions.js';

describe('dashboard roles', () => {
  it('gives the owner every permission', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('lets the analyzer read everything and operate the screen, but record no human decisions', () => {
    for (const p of ['data:read', 'health:read', 'exports:read', 'scan:operate'] as const)
      expect(can('analyzer', p)).toBe(true);
    for (const p of ['review:write', 'telegram:manage', 'users:manage'] as const)
      expect(can('analyzer', p)).toBe(false);
  });

  it('lets the reviewer read the market and record reviews, nothing operational or bulk', () => {
    expect(can('reviewer', 'data:read')).toBe(true);
    expect(can('reviewer', 'review:write')).toBe(true);
    for (const p of [
      'health:read',
      'exports:read',
      'scan:operate',
      'telegram:manage',
      'users:manage',
    ] as const)
      expect(can('reviewer', p)).toBe(false);
  });

  it('keeps user management, the Telegram audience and the settings owner-only', () => {
    for (const role of USER_ROLES) {
      expect(can(role, 'users:manage')).toBe(role === 'owner');
      expect(can(role, 'telegram:manage')).toBe(role === 'owner');
      expect(can(role, 'settings:manage')).toBe(role === 'owner');
    }
  });
});

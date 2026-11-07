import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService, LOCK_MINUTES, MAX_FAILED_LOGINS } from '../src/modules/auth/auth.service.js';
import { AppUser } from '../src/modules/auth/entities/app-user.entity.js';
import { UserSession } from '../src/modules/auth/entities/user-session.entity.js';
import { UsersService } from '../src/modules/auth/users.service.js';

import { makeApp, resetDb } from './utils/helpers.js';

let ctx: Awaited<ReturnType<typeof makeApp>>;
let users: UsersService;
let auth: AuthService;

beforeAll(async () => {
  ctx = await makeApp();
  users = ctx.app.get(UsersService);
  auth = ctx.app.get(AuthService);
});
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.db));

const sessionsOf = (userId: string) => ctx.repo(UserSession).countBy({ userId });

describe('bootstrap owner (an emptied database never locks the owner out)', () => {
  it('creates owner / owner on an empty database, flagged to change the password, once', async () => {
    expect(await users.ensureOwner()).toBe('created');
    expect(await users.ensureOwner()).toBe('exists');
    const all = await users.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ username: 'owner', role: 'owner', mustChangePassword: true });
    const s = await auth.login('owner', 'owner');
    expect(s.user.mustChangePassword).toBe(true);
  });

  it('never overwrites an existing "owner" account that is not an active owner', async () => {
    const r = await users.create({
      username: 'owner',
      role: 'reviewer',
      password: 'reviewer-pass-1',
    });
    expect(await users.ensureOwner()).toBe('blocked');
    expect((await users.findById(r.id))!.role).toBe('reviewer');
  });

  it('CLI recovery makes "owner" an active, unlocked owner again and ends its sessions', async () => {
    await users.ensureOwner();
    const owner = (await users.findByUsername('owner'))!;
    const s = await auth.login('owner', 'owner');
    await ctx
      .repo(AppUser)
      .update(
        { id: owner.id },
        { isActive: false, role: 'reviewer', lockedUntil: new Date(Date.now() + 3_600_000) },
      );
    const back = await users.resetOwner();
    expect(back).toMatchObject({
      role: 'owner',
      isActive: true,
      mustChangePassword: true,
      lockedUntil: null,
    });
    expect(await auth.userForToken(s.token)).toBeNull();
    expect((await auth.login('owner', 'owner')).user.role).toBe('owner');
  });
});

describe('sign-in', () => {
  beforeEach(async () => {
    await users.create(
      { username: 'Ana', role: 'analyzer', password: 'analyzer-pass-1' },
      { temporary: false },
    );
  });

  it('is case-insensitive on the username and gives one message for every failure', async () => {
    const s = await auth.login('ANA', 'analyzer-pass-1', { ip: '10.0.0.1', userAgent: 'test' });
    expect(s.user.username).toBe('ana');
    expect((await auth.userForToken(s.token))!.user.id).toBe(s.user.id);
    // Only the token's hash is stored.
    expect(await ctx.repo(UserSession).countBy({ id: s.token })).toBe(0);
    await expect(auth.login('ana', 'wrong')).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Wrong username or password.',
    });
    await expect(auth.login('nobody', 'wrong')).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Wrong username or password.',
    });
  });

  it(`locks the account for ${LOCK_MINUTES} min after ${MAX_FAILED_LOGINS} failures, even for the right password`, async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++)
      await expect(auth.login('ana', 'nope')).rejects.toMatchObject({
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    await expect(auth.login('ana', 'analyzer-pass-1')).rejects.toMatchObject({
      code: 'AUTH_LOCKED',
    });
    const later = new Date(Date.now() + (LOCK_MINUTES + 1) * 60_000);
    expect((await auth.login('ana', 'analyzer-pass-1', {}, later)).user.username).toBe('ana');
  });

  it('refuses a disabled account with the same message, and ends its sessions when disabled', async () => {
    await users.ensureOwner();
    const owner = (await users.findByUsername('owner'))!;
    const ana = (await users.findByUsername('ana'))!;
    const s = await auth.login('ana', 'analyzer-pass-1');
    await users.update(owner.id, ana.id, { isActive: false });
    expect(await auth.userForToken(s.token)).toBeNull();
    expect(await sessionsOf(ana.id)).toBe(0);
    await expect(auth.login('ana', 'analyzer-pass-1')).rejects.toMatchObject({
      message: 'Wrong username or password.',
    });
  });

  it('expires sessions and slides the expiry on use', async () => {
    const s = await auth.login('ana', 'analyzer-pass-1');
    const ttl = ctx.cfg.SESSION_TTL_HOURS * 3_600_000;
    expect(await auth.userForToken(s.token, new Date(Date.now() + ttl + 60_000))).toBeNull();
    const mid = new Date(Date.now() + ttl - 60_000);
    expect(await auth.userForToken(s.token, mid)).not.toBeNull(); // used: expiry moves forward
    expect(await auth.userForToken(s.token, new Date(mid.getTime() + ttl - 60_000))).not.toBeNull();
    await auth.logout(s.token);
    expect(await auth.userForToken(s.token)).toBeNull();
  });
});

describe('own account', () => {
  it('requires the current password, clears the forced change and ends other sessions', async () => {
    await users.ensureOwner();
    const a = await auth.login('owner', 'owner');
    const b = await auth.login('owner', 'owner');
    await expect(
      users.changeOwn(a.user.id, a.sessionId, {
        currentPassword: 'x',
        newPassword: 'a sound passphrase',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    await expect(
      users.changeOwn(a.user.id, a.sessionId, { currentPassword: 'owner', username: 'boss' }),
    ).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    await expect(
      users.changeOwn(a.user.id, a.sessionId, { currentPassword: 'owner', newPassword: 'owner' }),
    ).rejects.toMatchObject({ code: 'USER_INVALID' });
    const u = await users.changeOwn(a.user.id, a.sessionId, {
      currentPassword: 'owner',
      username: 'Boss',
      newPassword: 'a sound passphrase',
    });
    expect(u).toMatchObject({ username: 'boss', mustChangePassword: false });
    expect(await auth.userForToken(a.token)).not.toBeNull();
    expect(await auth.userForToken(b.token)).toBeNull();
    expect((await auth.login('boss', 'a sound passphrase')).user.role).toBe('owner');
  });

  it('keeps usernames unique', async () => {
    await users.create({ username: 'rev', role: 'reviewer', password: 'reviewer-pass-1' });
    await expect(
      users.create({ username: 'REV', role: 'analyzer', password: 'analyzer-pass-1' }),
    ).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    await expect(
      users.create({ username: '1x', role: 'analyzer', password: 'analyzer-pass-1' }),
    ).rejects.toMatchObject({ code: 'USER_INVALID' });
  });
});

describe('user management keeps at least one active owner', () => {
  it('refuses to demote, disable or delete yourself, or the last active owner', async () => {
    await users.ensureOwner();
    const owner = (await users.findByUsername('owner'))!;
    await expect(users.update(owner.id, owner.id, { role: 'analyzer' })).rejects.toMatchObject({
      code: 'LAST_OWNER',
    });
    await expect(users.update(owner.id, owner.id, { isActive: false })).rejects.toMatchObject({
      code: 'LAST_OWNER',
    });
    await expect(users.remove(owner.id, owner.id)).rejects.toMatchObject({ code: 'LAST_OWNER' });
    const second = await users.create({
      username: 'second',
      role: 'owner',
      password: 'second-pass-1',
    });
    // With two owners, one may demote the other, but not the last one left.
    await users.update(owner.id, second.id, { role: 'reviewer' });
    await expect(users.update(second.id, owner.id, { role: 'analyzer' })).rejects.toMatchObject({
      code: 'LAST_OWNER',
    });
  });

  it('resets a password as temporary, unlocks the account and ends its sessions', async () => {
    await users.ensureOwner();
    const r = await users.create(
      { username: 'rev', role: 'reviewer', password: 'reviewer-pass-1' },
      { temporary: false },
    );
    const s = await auth.login('rev', 'reviewer-pass-1');
    await ctx.repo(AppUser).update({ id: r.id }, { lockedUntil: new Date(Date.now() + 3_600_000) });
    const after = await users.resetPassword(r.id, 'temporary-pass-2');
    expect(after).toMatchObject({ mustChangePassword: true, lockedUntil: null });
    expect(await auth.userForToken(s.token)).toBeNull();
    expect((await auth.login('rev', 'temporary-pass-2')).user.mustChangePassword).toBe(true);
  });

  it('ends sessions when the role changes, and deleting a user removes its sessions', async () => {
    await users.ensureOwner();
    const owner = (await users.findByUsername('owner'))!;
    const r = await users.create(
      { username: 'rev', role: 'reviewer', password: 'reviewer-pass-1' },
      { temporary: false },
    );
    await auth.login('rev', 'reviewer-pass-1');
    await users.update(owner.id, r.id, { role: 'analyzer' });
    expect(await sessionsOf(r.id)).toBe(0);
    await auth.login('rev', 'reviewer-pass-1');
    await users.remove(owner.id, r.id);
    expect(await users.findById(r.id)).toBeNull();
    expect(await sessionsOf(r.id)).toBe(0);
  });

  it('never exposes the password hash', async () => {
    await users.ensureOwner();
    expect(JSON.stringify(await users.list())).not.toMatch(/scrypt|passwordHash/);
  });
});

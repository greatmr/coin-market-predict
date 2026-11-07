import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, Not } from 'typeorm';

import { type ErrorCode, ErrorCodes } from '../../common/dto/error-codes.js';
import { isUniqueViolation } from '../../common/entities/unique-violation.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { AppUser } from './entities/app-user.entity.js';
import { UserSession } from './entities/user-session.entity.js';
import {
  USERNAME_PATTERN,
  hashPassword,
  normalizeUsername,
  passwordProblems,
  verifyPassword,
} from './password.js';
import { type Permission, ROLE_PERMISSIONS, type UserRole } from './permissions.js';

/** The account created when the database has no active owner (the operator's request: owner / owner). */
export const BOOTSTRAP_OWNER = { username: 'owner', password: 'owner' } as const;

/** A refused user change, with a stable code and a sentence the dashboard shows as is. */
export class UserError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** What the API returns for a user: never the hash, never lockout internals beyond "locked until". */
export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  permissions: readonly Permission[];
  isActive: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  passwordChangedAt: string;
  createdAt: string;
}

export const toPublic = (u: AppUser): PublicUser => ({
  id: u.id,
  username: u.username,
  role: u.role,
  permissions: ROLE_PERMISSIONS[u.role],
  isActive: u.isActive,
  mustChangePassword: u.mustChangePassword,
  lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil.toISOString() : null,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  passwordChangedAt: u.passwordChangedAt.toISOString(),
  createdAt: u.createdAt.toISOString(),
});

/**
 * Dashboard users. Invariants enforced here (not in the UI): there is always at least one active
 * owner, an owner cannot lock themselves out from the dashboard, usernames are unique and
 * lowercase, and every password change or reset ends the user's other sessions.
 */
@Injectable()
export class UsersService {
  private readonly log = new Logger('Users');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private repo(m: EntityManager = this.db.manager) {
    return m.getRepository(AppUser);
  }

  async list(): Promise<PublicUser[]> {
    const users = await this.repo().find({ order: { createdAt: 'ASC' } });
    return users.map(toPublic);
  }

  async findById(id: string): Promise<AppUser | null> {
    return this.repo().findOneBy({ id });
  }

  async findByUsername(username: string): Promise<AppUser | null> {
    return this.repo().findOneBy({ username: normalizeUsername(username) });
  }

  private checkUsername(raw: string): string {
    const username = normalizeUsername(raw);
    if (!USERNAME_PATTERN.test(username))
      throw new UserError(
        ErrorCodes.USER_INVALID,
        'Usernames are 3–32 characters: letters, digits, dot, dash or underscore, starting with a letter.',
      );
    return username;
  }

  private checkPassword(password: string, username: string) {
    const problems = passwordProblems(password, username);
    if (problems.length) throw new UserError(ErrorCodes.USER_INVALID, problems.join(' '));
  }

  private async activeOwners(m: EntityManager, exceptId?: string): Promise<number> {
    return this.repo(m).count({
      where: { role: 'owner', isActive: true, ...(exceptId ? { id: Not(exceptId) } : {}) },
    });
  }

  private async getOrFail(m: EntityManager, id: string): Promise<AppUser> {
    const u = await this.repo(m).findOneBy({ id });
    if (!u) throw new UserError(ErrorCodes.USER_NOT_FOUND, 'No such user.', 404);
    return u;
  }

  private endSessions(m: EntityManager, userId: string, exceptSessionId?: string) {
    return m.getRepository(UserSession).delete({
      userId,
      ...(exceptSessionId ? { id: Not(exceptSessionId) } : {}),
    });
  }

  /** New user with a temporary password the person must change at first sign-in. */
  async create(
    input: { username: string; role: UserRole; password: string },
    opts = { temporary: true },
  ) {
    const username = this.checkUsername(input.username);
    this.checkPassword(input.password, username);
    try {
      const saved = await this.repo().save(
        this.repo().create({
          username,
          role: input.role,
          passwordHash: await hashPassword(input.password),
          mustChangePassword: opts.temporary,
        }),
      );
      return toPublic(saved);
    } catch (err) {
      if (isUniqueViolation(err))
        throw new UserError(ErrorCodes.USERNAME_TAKEN, `The username “${username}” is taken.`, 409);
      throw err;
    }
  }

  /** Role and active flag, changed by an owner. Never removes the last active owner. */
  async update(actorId: string, id: string, patch: { role?: UserRole; isActive?: boolean }) {
    return this.db.transaction(async (m) => {
      const u = await this.getOrFail(m, id);
      const losesOwner =
        u.role === 'owner' &&
        u.isActive &&
        ((patch.role !== undefined && patch.role !== 'owner') || patch.isActive === false);
      if (losesOwner && id === actorId)
        throw new UserError(
          ErrorCodes.LAST_OWNER,
          "You can't remove your own owner access. Ask another owner, or use the CLI.",
        );
      if (losesOwner && (await this.activeOwners(m, id)) === 0)
        throw new UserError(ErrorCodes.LAST_OWNER, 'At least one active owner must remain.');
      const roleChanged = patch.role !== undefined && patch.role !== u.role;
      if (patch.role !== undefined) u.role = patch.role;
      if (patch.isActive !== undefined) u.isActive = patch.isActive;
      if (patch.isActive === true) {
        u.failedLogins = 0;
        u.lockedUntil = null;
      }
      const saved = await this.repo(m).save(u);
      // A disabled account or a changed role takes effect immediately, not at the next sign-in.
      if (patch.isActive === false || roleChanged) await this.endSessions(m, id);
      return toPublic(saved);
    });
  }

  /** An owner sets a temporary password: the user must change it at the next sign-in. */
  async resetPassword(id: string, password: string, opts = { temporary: true }) {
    return this.db.transaction(async (m) => {
      const u = await this.getOrFail(m, id);
      this.checkPassword(password, u.username);
      u.passwordHash = await hashPassword(password);
      u.mustChangePassword = opts.temporary;
      u.passwordChangedAt = new Date();
      u.failedLogins = 0;
      u.lockedUntil = null;
      const saved = await this.repo(m).save(u);
      await this.endSessions(m, id);
      return toPublic(saved);
    });
  }

  async remove(actorId: string, id: string) {
    await this.db.transaction(async (m) => {
      const u = await this.getOrFail(m, id);
      if (id === actorId)
        throw new UserError(ErrorCodes.LAST_OWNER, "You can't delete your own account.");
      if (u.role === 'owner' && u.isActive && (await this.activeOwners(m, id)) === 0)
        throw new UserError(ErrorCodes.LAST_OWNER, 'At least one active owner must remain.');
      await this.repo(m).delete({ id });
    });
  }

  /**
   * A signed-in user changes their own username and/or password. The current password is always
   * required. A new password clears "must change" and ends every other session.
   */
  async changeOwn(
    userId: string,
    sessionId: string,
    input: { currentPassword: string; username?: string; newPassword?: string },
  ) {
    return this.db.transaction(async (m) => {
      const u = await this.getOrFail(m, userId);
      if (!(await verifyPassword(input.currentPassword, u.passwordHash)))
        throw new UserError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Your current password is wrong.');
      const username =
        input.username !== undefined ? this.checkUsername(input.username) : u.username;
      if (u.mustChangePassword && !input.newPassword)
        throw new UserError(ErrorCodes.PASSWORD_CHANGE_REQUIRED, 'Choose a new password first.');
      if (input.newPassword !== undefined) {
        this.checkPassword(input.newPassword, username);
        if (await verifyPassword(input.newPassword, u.passwordHash))
          throw new UserError(ErrorCodes.USER_INVALID, 'Choose a password you have not used here.');
        u.passwordHash = await hashPassword(input.newPassword);
        u.mustChangePassword = false;
        u.passwordChangedAt = new Date();
      }
      u.username = username;
      let saved: AppUser;
      try {
        saved = await this.repo(m).save(u);
      } catch (err) {
        if (isUniqueViolation(err))
          throw new UserError(
            ErrorCodes.USERNAME_TAKEN,
            `The username “${username}” is taken.`,
            409,
          );
        throw err;
      }
      if (input.newPassword !== undefined) await this.endSessions(m, userId, sessionId);
      return toPublic(saved);
    });
  }

  /**
   * Called when the web server starts: with no active owner, create the bootstrap owner
   * (`owner` / INITIAL_OWNER_PASSWORD, default `owner`, which must be changed at first sign-in).
   * Never touches an existing account; if `owner` exists but is not an active owner, it logs how
   * to recover with the CLI instead.
   */
  async ensureOwner(): Promise<'exists' | 'created' | 'blocked'> {
    if ((await this.activeOwners(this.db.manager)) > 0) return 'exists';
    const taken = await this.findByUsername(BOOTSTRAP_OWNER.username);
    if (taken) {
      this.log.error(
        `No active owner, and the username "${BOOTSTRAP_OWNER.username}" is used by a ${taken.isActive ? taken.role : 'disabled'} account. Recover with: npm run cli -- users:reset-owner`,
      );
      return 'blocked';
    }
    const fromEnv = this.cfg.INITIAL_OWNER_PASSWORD;
    await this.repo().save(
      this.repo().create({
        username: BOOTSTRAP_OWNER.username,
        role: 'owner',
        passwordHash: await hashPassword(fromEnv ?? BOOTSTRAP_OWNER.password),
        mustChangePassword: true,
      }),
    );
    this.log.warn(
      `Created the owner account "${BOOTSTRAP_OWNER.username}" ${fromEnv ? 'with the password from INITIAL_OWNER_PASSWORD' : 'with the default password "owner"'}. Sign in and choose a new password: the dashboard asks for it before anything else.`,
    );
    return 'created';
  }

  /**
   * CLI recovery: make `owner` an active owner again with password `owner` (must change at sign-in),
   * unlock it and end its sessions. Creates the account if it does not exist.
   */
  async resetOwner(password: string = BOOTSTRAP_OWNER.password): Promise<PublicUser> {
    return this.db.transaction(async (m) => {
      const repo = this.repo(m);
      const existing = await repo.findOneBy({ username: BOOTSTRAP_OWNER.username });
      const u =
        existing ??
        repo.create({ username: BOOTSTRAP_OWNER.username, role: 'owner', passwordHash: '' });
      u.role = 'owner';
      u.isActive = true;
      u.passwordHash = await hashPassword(password);
      u.mustChangePassword = true;
      u.passwordChangedAt = new Date();
      u.failedLogins = 0;
      u.lockedUntil = null;
      const saved = await repo.save(u);
      await this.endSessions(m, saved.id);
      return toPublic(saved);
    });
  }
}

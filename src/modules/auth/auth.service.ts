import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { type DataSource, LessThan } from 'typeorm';

import { ErrorCodes } from '../../common/dto/error-codes.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { AppUser } from './entities/app-user.entity.js';
import { UserSession } from './entities/user-session.entity.js';
import { dummyHash, normalizeUsername, verifyPassword } from './password.js';
import { UserError } from './users.service.js';

/** Consecutive failures before an account is locked, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
/** A session's expiry moves forward on use, written at most this often. */
const TOUCH_EVERY_MS = 5 * 60_000;

export const sessionIdOf = (token: string) => createHash('sha256').update(token).digest('hex');

export interface SignedIn {
  token: string;
  sessionId: string;
  user: AppUser;
  expiresAt: Date;
}

/**
 * Sign-in and sessions. A session is a random 32-byte token in an HttpOnly cookie; the database
 * keeps only its SHA-256. Unknown usernames cost the same time as wrong passwords, and repeated
 * failures lock the account for a while (an owner or the CLI can unlock it sooner).
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private get ttlMs() {
    return this.cfg.SESSION_TTL_HOURS * 3_600_000;
  }

  async login(
    rawUsername: string,
    password: string,
    meta: { ip?: string | null; userAgent?: string | null } = {},
    now = new Date(),
  ): Promise<SignedIn> {
    const users = this.db.getRepository(AppUser);
    const user = await users.findOneBy({ username: normalizeUsername(rawUsername) });
    const invalid = new UserError(
      ErrorCodes.AUTH_INVALID_CREDENTIALS,
      'Wrong username or password.',
    );
    if (!user) {
      await verifyPassword(password, await dummyHash());
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000);
      throw new UserError(
        ErrorCodes.AUTH_LOCKED,
        `Too many failed sign-ins. Try again in ${minutes} min, or ask an owner to reset your password.`,
      );
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLogins + 1;
      await users.update(
        { id: user.id },
        failed >= MAX_FAILED_LOGINS
          ? { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) }
          : { failedLogins: failed },
      );
      throw invalid;
    }
    // Same message as a wrong password: a disabled account does not reveal that it exists.
    if (!user.isActive) throw invalid;
    await users.update({ id: user.id }, { failedLogins: 0, lockedUntil: null, lastLoginAt: now });
    const token = randomBytes(32).toString('base64url');
    const sessionId = sessionIdOf(token);
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const sessions = this.db.getRepository(UserSession);
    await sessions.delete({ expiresAt: LessThan(now) }); // housekeeping, cheap at this size
    await sessions.insert({
      id: sessionId,
      userId: user.id,
      expiresAt,
      lastSeenAt: now,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
    });
    return { token, sessionId, user: { ...user, lastLoginAt: now }, expiresAt };
  }

  /** The active user behind a cookie token, or null. Slides the expiry forward on use. */
  async userForToken(
    token: string | undefined,
    now = new Date(),
  ): Promise<{ user: AppUser; sessionId: string } | null> {
    if (!token || token.length > 200) return null;
    const sessionId = sessionIdOf(token);
    const sessions = this.db.getRepository(UserSession);
    const s = await sessions.findOne({ where: { id: sessionId }, relations: { user: true } });
    if (!s || !s.user || s.expiresAt <= now || !s.user.isActive) return null;
    if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS)
      await sessions.update(
        { id: sessionId },
        { lastSeenAt: now, expiresAt: new Date(now.getTime() + this.ttlMs) },
      );
    return { user: s.user, sessionId };
  }

  async logout(token: string | undefined) {
    if (token) await this.db.getRepository(UserSession).delete({ id: sessionIdOf(token) });
  }
}

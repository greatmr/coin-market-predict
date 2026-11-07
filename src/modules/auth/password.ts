import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt (no native dependency). Stored as
 * `scrypt$N$r$p$<salt b64>$<hash b64>` so the cost can be raised later without breaking old hashes.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, len, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const key = await derive(
    password,
    Buffer.from(saltB64, 'base64'),
    Number(n),
    Number(r),
    Number(p),
    expected.length,
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Verified against when the username does not exist, so a wrong username takes as long as a wrong
 * password and the response time does not reveal which accounts exist.
 */
let dummy: Promise<string> | null = null;
export const dummyHash = (): Promise<string> =>
  (dummy ??= hashPassword(randomBytes(24).toString('base64')));

const WEAK = new Set(['password', 'owner', 'admin', 'administrator', '12345678', 'qwertyui']);

/** Problems with a new password, as sentences for the person choosing it (empty when acceptable). */
export function passwordProblems(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < 8) problems.push('Use at least 8 characters.');
  if (password.length > 128) problems.push('Use at most 128 characters.');
  if (password.toLowerCase() === username.toLowerCase())
    problems.push('The password must differ from the username.');
  if (WEAK.has(password.toLowerCase())) problems.push('That password is too common.');
  return problems;
}

/** Usernames are stored lowercase: 3–32 of a–z, 0–9, dot, dash and underscore, starting with a letter. */
export const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{2,31}$/;
export const normalizeUsername = (u: string) => u.trim().toLowerCase();

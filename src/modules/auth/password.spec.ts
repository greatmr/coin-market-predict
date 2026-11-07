import { describe, expect, it } from 'vitest';

import {
  USERNAME_PATTERN,
  hashPassword,
  normalizeUsername,
  passwordProblems,
  verifyPassword,
} from './password.js';

describe('passwords', () => {
  it('hashes with a random salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('correct horsE', a)).toBe(false);
    expect(await verifyPassword('correct horse', 'plain-text')).toBe(false);
  });

  it('explains what is wrong with a weak password', () => {
    expect(passwordProblems('short', 'ana')).toContain('Use at least 8 characters.');
    expect(passwordProblems('reviewer1', 'Reviewer1')).toContain(
      'The password must differ from the username.',
    );
    expect(passwordProblems('Password', 'ana')).toContain('That password is too common.');
    expect(passwordProblems('x'.repeat(129), 'ana')).toContain('Use at most 128 characters.');
    expect(passwordProblems('a sound passphrase', 'ana')).toEqual([]);
  });

  it('accepts lowercase usernames of 3–32 characters starting with a letter', () => {
    expect(normalizeUsername('  Owner ')).toBe('owner');
    for (const ok of ['owner', 'ana.k', 'rev_2', 'a-b'])
      expect(USERNAME_PATTERN.test(ok)).toBe(true);
    for (const bad of ['ab', '1abc', 'with space', 'a'.repeat(33), 'ünï'])
      expect(USERNAME_PATTERN.test(bad)).toBe(false);
  });
});

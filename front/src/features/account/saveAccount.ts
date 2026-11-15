import { apiPost } from '../../lib/api';
import type { User } from '../../types/api';

export interface AccountChange {
  username: string;
  current: string;
  next: string;
  repeat: string;
}

/**
 * Change own username and/or password (account page and the required-change form). Returns the
 * updated user and whether the password changed (other sessions are then signed out).
 */
export async function saveAccount(
  me: User,
  { username, current, next, repeat }: AccountChange,
): Promise<{ user: User; passwordChanged: boolean }> {
  if (next !== repeat) throw new Error("The new passwords don't match.");
  const body: { currentPassword: string; username?: string; newPassword?: string } = {
    currentPassword: current,
  };
  if (username && username.toLowerCase() !== me.username) body.username = username;
  if (next) body.newPassword = next;
  if (!body.username && !body.newPassword)
    throw new Error('Change the username or the password first.');
  const { user } = await apiPost<{ user: User }>('auth/account', body);
  return { user, passwordChanged: !!body.newPassword };
}

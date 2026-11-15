// The browser's session: who is signed in, or why not. Owned by the root route so /login and the
// signed-in pages share it; an API call that finds the session gone flips it back to sign-in.
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { api, apiPost, errorMessage, setAuthLostHandler } from '../lib/api';
import type { User } from '../types/api';

export type SessionStatus = 'loading' | 'anon' | 'change' | 'ready' | 'error';

export interface Session {
  status: SessionStatus;
  me: User | null;
  /** Message for the sign-in form ("Your session ended…") or the start-up error. */
  notice: string;
  setMe: (u: User) => void;
  /** After a successful sign-in or password change. */
  signedIn: (u: User) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession() outside SessionProvider');
  return s;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMeState] = useState<User | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setAuthLostHandler((mode, msg) => {
      setNotice(msg ?? '');
      setStatus(mode === 'login' ? 'anon' : 'change');
    });
    let cancelled = false;
    api<{ user: User }>('auth/me')
      .then(({ user }) => {
        if (cancelled) return;
        setMeState(user);
        setStatus(user.mustChangePassword ? 'change' : 'ready');
      })
      .catch((e: { code?: string }) => {
        if (cancelled) return;
        if (e.code === 'AUTH_REQUIRED') setStatus('anon');
        else if (e.code === 'PASSWORD_CHANGE_REQUIRED') setStatus('change');
        else {
          setNotice(errorMessage(e));
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
      setAuthLostHandler(null);
    };
  }, []);

  const setMe = useCallback((u: User) => setMeState(u), []);
  const signedIn = useCallback((u: User) => {
    setMeState(u);
    setNotice('');
    setStatus(u.mustChangePassword ? 'change' : 'ready');
  }, []);
  const signOut = useCallback(async () => {
    try {
      await apiPost('auth/logout', {});
    } catch {
      /* the cookie is cleared or already gone */
    }
    setMeState(null);
    setNotice('');
    setStatus('anon');
  }, []);

  const value = useMemo(
    () => ({ status, me, notice, setMe, signedIn, signOut }),
    [status, me, notice, setMe, signedIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

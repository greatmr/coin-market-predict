// /login and /change-password (first owner sign-in or a temporary password). Both return to the
// page in ?next= afterwards.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';

import { Icon } from '../../components/icons';
import { apiPost, errorMessage } from '../../lib/api';
import { toast } from '../../lib/feedback';
import { useSession } from '../../state/session';
import type { User } from '../../types/api';

import { saveAccount } from '../account/saveAccount';

export const USERNAME_PATTERN = String.raw`[A-Za-z][A-Za-z0-9._\-]{2,31}`;

/** Only same-app paths are followed after sign-in (no open redirect). */
function useNext(): string {
  const [params] = useSearchParams();
  const next = params.get('next') || '/';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function AuthCard({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.title = 'Sign in · Coins Predicts';
  }, []);
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-mark">
          <Icon name="mark" viewBox="0 0 32 32" />
          <span>Coins Predicts</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const next = useNext();
  const [error, setError] = useState(session.notice);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const userRef = useRef<HTMLInputElement | null>(null);
  const passRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => userRef.current?.focus(), []);
  if (session.status === 'ready') return <Navigate to={next} replace />;
  if (session.status === 'change')
    return <Navigate to={`/change-password?next=${encodeURIComponent(next)}`} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await apiPost<{ user: User }>('auth/login', { username, password });
      session.signedIn(user);
      navigate(
        user.mustChangePassword ? `/change-password?next=${encodeURIComponent(next)}` : next,
        { replace: true },
      );
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
      setBusy(false);
      setTimeout(() => passRef.current?.focus(), 0);
    }
  };

  return (
    <AuthCard>
      <form className="stack-form" autoComplete="on" onSubmit={submit}>
        <fieldset className="plain" disabled={busy}>
          <h1>Sign in</h1>
          <p className="muted small">Hourly VMC research screen. Ask the owner for an account.</p>
          <label className="field">
            <span>Username</span>
            <input
              ref={userRef}
              name="username"
              required
              maxLength={64}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              ref={passRef}
              name="password"
              type="password"
              required
              maxLength={256}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="form-error" role="alert">
            {error}
          </div>
          <button type="submit" className="btn primary wide">
            Sign in
          </button>
        </fieldset>
      </form>
    </AuthCard>
  );
}

export function ChangePasswordPage() {
  const session = useSession();
  const navigate = useNavigate();
  const next = useNext();
  const me = session.me;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ username: me?.username ?? '', current: '', next: '', repeat: '' });
  const currentRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => currentRef.current?.focus(), []);

  if (session.status === 'anon')
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  if (session.status === 'ready') return <Navigate to={next} replace />;
  if (session.status === 'loading') return <AuthCard>{null}</AuthCard>;

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!me) return;
    setBusy(true);
    try {
      const { user } = await saveAccount(me, { ...f, username: f.username.trim() });
      toast('Saved. Welcome in.');
      session.signedIn(user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const lead =
    me && me.username === 'owner' && me.role === 'owner'
      ? 'This is the first sign-in of the owner account. Choose your own username and password to continue.'
      : 'Your password is temporary. Choose your own to continue.';

  return (
    <AuthCard>
      <form className="stack-form" autoComplete="off" onSubmit={submit}>
        <fieldset className="plain" disabled={busy}>
          <h1>Choose a new password</h1>
          <p className="muted small">{lead}</p>
          <label className="field">
            <span>Username</span>
            <input
              required
              minLength={3}
              maxLength={32}
              pattern={USERNAME_PATTERN}
              autoComplete="username"
              spellCheck={false}
              value={f.username}
              onChange={set('username')}
            />
          </label>
          <label className="field">
            <span>Current password</span>
            <input
              ref={currentRef}
              type="password"
              required
              maxLength={256}
              autoComplete="current-password"
              value={f.current}
              onChange={set('current')}
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              value={f.next}
              onChange={set('next')}
            />
          </label>
          <label className="field">
            <span>Repeat new password</span>
            <input
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              value={f.repeat}
              onChange={set('repeat')}
            />
          </label>
          <div className="form-error" role="alert">
            {error}
          </div>
          <button type="submit" className="btn primary wide">
            Save and continue
          </button>
          <button
            type="button"
            className="btn wide"
            onClick={() => void session.signOut().then(() => navigate('/login', { replace: true }))}
          >
            Sign out
          </button>
        </fieldset>
      </form>
    </AuthCard>
  );
}

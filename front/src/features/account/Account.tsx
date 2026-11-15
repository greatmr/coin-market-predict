import { type ChangeEvent, type FormEvent, useState } from 'react';

import { Icon } from '../../components/icons';
import { errorMessage } from '../../lib/api';
import { PERMISSION_TEXT, ROLE_TEXT } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo } from '../../lib/format';
import {
  THEME_MODES,
  setRailCollapsed,
  setTheme,
  useRailCollapsed,
  useTheme,
} from '../../lib/prefs';
import { useApp } from '../../state/app';
import type { Permission } from '../../types/api';

import { USERNAME_PATTERN } from '../auth/AuthScreen';

import { saveAccount } from './saveAccount';

const EMPTY = { current: '', next: '', repeat: '' };

export default function Account() {
  const { me, setMe } = useApp();
  const [username, setUsername] = useState(me.username);
  const [pw, setPw] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [label, text] = ROLE_TEXT[me.role];
  const setP = (k: keyof typeof EMPTY) => (e: ChangeEvent<HTMLInputElement>) =>
    setPw((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { user, passwordChanged } = await saveAccount(me, {
        username: username.trim(),
        current: pw.current,
        next: pw.next,
        repeat: pw.repeat,
      });
      setMe(user);
      setUsername(user.username);
      setPw(EMPTY);
      toast(passwordChanged ? 'Saved. Your other sessions were signed out.' : 'Saved.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Appearance />
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Sign-in details</h2>
            <span className="hint">password changed {fmtAgo(me.passwordChangedAt)}</span>
          </div>
          <form className="stack-form" autoComplete="off" onSubmit={submit}>
            <fieldset className="plain" disabled={busy}>
              <label className="field">
                <span>Username</span>
                <input
                  required
                  minLength={3}
                  maxLength={32}
                  pattern={USERNAME_PATTERN}
                  autoComplete="username"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label className="field">
                <span>New password</span>
                <input
                  type="password"
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  placeholder="Leave empty to keep the current one"
                  value={pw.next}
                  onChange={setP('next')}
                />
              </label>
              <label className="field">
                <span>Repeat new password</span>
                <input
                  type="password"
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={pw.repeat}
                  onChange={setP('repeat')}
                />
              </label>
              <label className="field">
                <span>Current password</span>
                <input
                  type="password"
                  required
                  maxLength={256}
                  autoComplete="current-password"
                  value={pw.current}
                  onChange={setP('current')}
                />
              </label>
              <div className="row-actions">
                <button type="submit" className="btn primary">
                  Save changes
                </button>
              </div>
            </fieldset>
          </form>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Your access</h2>
          </div>
          <div className="role-row">
            <span className={`avatar ${me.role}`} aria-hidden="true">
              <Icon name="account" />
            </span>
            <div>
              <b>{label}</b>
              <p className="muted small">{text}</p>
            </div>
          </div>
          <ul className="perm-list">
            {(Object.entries(PERMISSION_TEXT) as [Permission, string][]).map(([perm, t]) => {
              const yes = me.permissions.includes(perm);
              return (
                <li key={perm} className={yes ? 'yes' : 'no'}>
                  <span className="perm-mark" aria-hidden="true">
                    {yes ? '✓' : '–'}
                  </span>
                  <span>{t}</span>
                  <span className="sr-only">{yes ? 'allowed' : 'not allowed'}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </>
  );
}

/** How the dashboard looks in this browser: colour theme and the desktop sidebar. */
function Appearance() {
  const theme = useTheme();
  const collapsed = useRailCollapsed();
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Appearance</h2>
        <span className="hint">saved in this browser only</span>
      </div>
      <div className="pref-rows">
        <div className="pref-row">
          <div>
            <b>Colour theme</b>
            <p className="muted small">Auto follows your system's light or dark setting.</p>
          </div>
          <div className="seg" role="group" aria-label="Colour theme">
            {THEME_MODES.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={theme === k} onClick={() => setTheme(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="pref-row">
          <div>
            <b>Sidebar on desktop</b>
            <p className="muted small">
              Collapsed shows icons only; the button on the sidebar's edge switches it too.
            </p>
          </div>
          <div className="seg" role="group" aria-label="Sidebar on desktop">
            <button type="button" aria-pressed={!collapsed} onClick={() => setRailCollapsed(false)}>
              Expanded
            </button>
            <button type="button" aria-pressed={collapsed} onClick={() => setRailCollapsed(true)}>
              Collapsed
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

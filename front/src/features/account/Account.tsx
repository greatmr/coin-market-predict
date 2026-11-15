import { type ChangeEvent, type FormEvent, useState } from 'react';

import { errorMessage } from '../../lib/api';
import { PERMISSION_TEXT, ROLE_TEXT } from '../../lib/constants';
import { toast } from '../../lib/feedback';
import { fmtAgo } from '../../lib/format';
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
            {me.username.slice(0, 1).toUpperCase()}
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
  );
}

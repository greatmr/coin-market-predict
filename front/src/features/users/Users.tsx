// Users (owner): who can sign in, their role and status, and the role matrix.
import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { type Column, LoadError, StatusLabel, Table } from '../../components/ui';
import { api, apiDelete, apiPatch, apiPost, errorMessage } from '../../lib/api';
import { ROLE_TEXT } from '../../lib/constants';
import { dialog, toast } from '../../lib/feedback';
import { fmtAgo, fmtClock, fmtTime } from '../../lib/format';
import { useApp } from '../../state/app';
import type { Role, User } from '../../types/api';

import { USERNAME_PATTERN } from '../auth/AuthScreen';

const ROLES = Object.entries(ROLE_TEXT) as [Role, readonly [string, string]][];

const userStatus = (u: User) =>
  !u.isActive ? (
    <StatusLabel text="Disabled" />
  ) : u.lockedUntil ? (
    <StatusLabel dot="critical" text={`Locked until ${fmtClock(u.lockedUntil)}`} />
  ) : u.mustChangePassword ? (
    <StatusLabel dot="warning" text="Must set password" />
  ) : (
    <StatusLabel dot="good" text="Active" />
  );

export default function Users() {
  const { me } = useApp();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api<User[]>('users'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const changeRole = async (u: User, role: Role) => {
    try {
      await apiPatch(`users/${u.id}`, { role });
      toast(`${u.username} is now ${ROLE_TEXT[role][0].toLowerCase()}. Their sessions were ended.`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    await load();
  };
  const toggleActive = async (u: User) => {
    try {
      await apiPatch(`users/${u.id}`, { isActive: !u.isActive });
      toast(
        u.isActive
          ? `${u.username} is disabled and signed out.`
          : `${u.username} can sign in again.`,
      );
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    await load();
  };
  const resetPassword = (u: User) =>
    dialog({
      title: `Reset ${u.username}'s password`,
      body: (
        <>
          <p className="muted small">
            Give them this temporary password. They choose their own at the next sign-in, and every
            session they have now ends.
          </p>
          <label className="field">
            <span>Temporary password</span>
            <input
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
        </>
      ),
      ok: 'Reset password',
      onSubmit: async (fd) => {
        await apiPost(`users/${u.id}/password`, { password: fd.get('password') });
        toast(`Password reset for ${u.username}.`);
      },
    }).then((done) => {
      if (done) void load();
    });
  const deleteUser = (u: User) =>
    dialog({
      title: `Delete ${u.username}?`,
      body: (
        <p>
          They can no longer sign in. Reviews they recorded keep their name. To pause access
          instead, disable the account.
        </p>
      ),
      ok: 'Delete user',
      danger: true,
      onSubmit: async () => {
        await apiDelete(`users/${u.id}`);
        toast(`Deleted ${u.username}.`);
      },
    }).then((done) => {
      if (done) void load();
    });

  const cols: Column<User>[] = [
    {
      label: 'User',
      render: (u) => (
        <div className="coin">
          <span className={`avatar ${u.role}`} aria-hidden="true">
            {u.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="coin-text">
            <b>
              {u.username}
              {u.id === me.id ? <span className="chip you">you</span> : null}
            </b>
            <span>added {fmtTime(u.createdAt, { year: true })}</span>
          </div>
        </div>
      ),
    },
    {
      label: 'Role',
      render: (u) => (
        <select
          aria-label={`Role of ${u.username}`}
          disabled={u.id === me.id}
          value={u.role}
          onChange={(e) => void changeRole(u, e.target.value as Role)}
        >
          {ROLES.map(([k, [label]]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      ),
    },
    { label: 'Status', render: userStatus },
    {
      label: 'Last sign-in',
      render: (u) => (u.lastLoginAt ? fmtAgo(u.lastLoginAt) : <span className="muted">never</span>),
    },
    {
      label: '',
      render: (u) => (
        <div className="row-actions">
          <button type="button" className="btn small" onClick={() => void resetPassword(u)}>
            Reset password
          </button>
          {u.id === me.id ? null : (
            <button type="button" className="btn small" onClick={() => void toggleActive(u)}>
              {u.isActive ? 'Disable' : 'Enable'}
            </button>
          )}
          {u.id === me.id ? null : (
            <button type="button" className="btn small danger" onClick={() => void deleteUser(u)}>
              Delete
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>People who can sign in</h2>
          <span className="hint">
            {users ? `${users.length} ${users.length === 1 ? 'person' : 'people'}` : ''}
          </span>
        </div>
        <div className="table-wrap">
          {error ? (
            <LoadError error={error} />
          ) : users ? (
            <Table cols={cols} rows={users} empty="No users." rowKey={(u) => u.id} />
          ) : null}
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Add a user</h2>
            <span className="hint">they choose their own password at first sign-in</span>
          </div>
          <AddUserForm onAdded={load} />
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>What each role can do</h2>
          </div>
          <div className="role-matrix">
            {ROLES.map(([k, [label, text]]) => (
              <div key={k} className="role-row">
                <span className={`avatar ${k}`} aria-hidden="true">
                  {label.slice(0, 1)}
                </span>
                <div>
                  <b>{label}</b>
                  <p className="muted small">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function AddUserForm({ onAdded }: { onAdded: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setBusy(true);
    try {
      const u = await apiPost<User>('users', {
        username: String(fd.get('username') ?? '').trim(),
        role: fd.get('role'),
        password: fd.get('password'),
      });
      toast(`Added ${u.username}. Share the temporary password with them privately.`);
      form.reset();
      await onAdded();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack-form" autoComplete="off" onSubmit={submit}>
      <fieldset className="plain" disabled={busy}>
        <label className="field">
          <span>Username</span>
          <input
            name="username"
            required
            minLength={3}
            maxLength={32}
            pattern={USERNAME_PATTERN}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select name="role" defaultValue="reviewer">
            {ROLES.map(([k, [label]]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Temporary password</span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <div className="row-actions">
          <button type="submit" className="btn primary">
            Add user
          </button>
        </div>
      </fieldset>
    </form>
  );
}

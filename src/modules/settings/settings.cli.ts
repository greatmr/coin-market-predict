import { DataSource } from 'typeorm';

import { registerSecretsFromEnv } from '../../common/security/redact.js';

import { type SavedSettings, resolveFileSecrets, settingDef } from '../../config/index.js';

import { buildDataSourceOptions } from '../../database/typeorm-options.js';

import {
  type SettingChange,
  type SettingsPlan,
  type SettingsView,
  describeSettings,
  planImport,
  planSettings,
} from './settings.plan.js';
import {
  type SettingsActor,
  lockSettings,
  readHistory,
  readSavedSettings,
  readSavedValues,
  writeChanges,
} from './settings.store.js';

export const SETTINGS_HELP = `
  Dashboard settings (docs/adr/0005-dashboard-settings.md; precedence: environment > dashboard > default)
  settings:list [--json]       Every setting: value, where it comes from, live or at restart
  settings:set KEY VALUE       Save a setting (validated as in the dashboard). The server applies it
                               at its next scheduled run; restart it to apply now
  settings:reset KEY [KEY …]   Remove saved settings (back to the environment value or the default)
  settings:import-env [--dry-run]
                               Copy the settings set in the environment into the dashboard, so their
                               lines can be removed from .env / .env.prod
  settings:history [--limit N] Recent changes: who, when, from what to what
`;

const show = (v: unknown): string =>
  v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

/**
 * The `settings:*` commands. They use their own short-lived connection, not the Nest application,
 * so they also work when saved settings keep the server from starting (`settings:reset` is the
 * way back). They validate against this process's environment, which is the server's own inside
 * its container (`docker compose exec app node dist/cli.js settings:…`).
 */
export async function settingsCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  out: (text: string) => void,
): Promise<number> {
  const flag = (name: string) => args.includes(name);
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');
  const cli: SettingsActor = { userId: null, name: 'cli', source: 'cli' };

  switch (cmd) {
    case 'settings:list': {
      const view = await withDb(env, async (ds) =>
        describeSettings({
          env,
          saved: await readSavedSettings(ds.manager),
          running: null,
          waitingForRun: false,
        }),
      );
      out(flag('--json') ? JSON.stringify(view, null, 2) : renderList(view));
      return view.problems.length ? 1 : 0;
    }
    case 'settings:set': {
      const [key, ...value] = positional;
      if (!key || !value.length) throw new Error('usage: settings:set KEY VALUE');
      return write(
        env,
        out,
        (saved) => planSettings(env, saved, { values: { [key]: value.join(' ') } }),
        cli,
      );
    }
    case 'settings:reset': {
      if (!positional.length) throw new Error('usage: settings:reset KEY [KEY …]');
      return write(env, out, (saved) => planSettings(env, saved, { reset: positional }), cli);
    }
    case 'settings:import-env':
      return write(
        env,
        out,
        (saved) => planImport(env, saved),
        { ...cli, source: 'import_env' },
        {
          dryRun: flag('--dry-run'),
          afterImport: true,
        },
      );
    case 'settings:history': {
      const limit = Number(option('--limit') ?? 30);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new Error('usage: settings:history [--limit 1-500]');
      const rows = await withDb(env, (ds) => readHistory(ds.manager, limit));
      out(
        rows.length
          ? rows
              .map(
                (r) =>
                  `${r.changedAt.slice(0, 19).replace('T', ' ')}Z  ${r.changedBy.padEnd(16)} ${r.source.padEnd(10)} ${r.key}: ${show(r.oldValue)} → ${show(r.newValue)}`,
              )
              .join('\n')
          : 'No settings changes yet.',
      );
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}${SETTINGS_HELP}`);
  }
}

async function withDb<T>(env: NodeJS.ProcessEnv, fn: (ds: DataSource) => Promise<T>): Promise<T> {
  const resolved = resolveFileSecrets(env);
  registerSecretsFromEnv(resolved);
  const ds = new DataSource(buildDataSourceOptions((key) => resolved[key]));
  await ds.initialize();
  try {
    return await fn(ds);
  } finally {
    await ds.destroy();
  }
}

async function write(
  env: NodeJS.ProcessEnv,
  out: (text: string) => void,
  plan: (saved: SavedSettings) => SettingsPlan,
  actor: SettingsActor,
  opts: { dryRun?: boolean; afterImport?: boolean } = {},
): Promise<number> {
  const p = await withDb(env, (ds) =>
    ds.transaction(async (m) => {
      await lockSettings(m);
      const result = plan(await readSavedValues(m));
      if (!result.issues.length && !opts.dryRun) await writeChanges(m, result.changes, actor);
      return result;
    }),
  );
  if (p.issues.length) {
    out(['Nothing was saved:', ...p.issues.map((i) => `  ${i.key}: ${i.message}`)].join('\n'));
    return 2;
  }
  const lines = p.changes.length
    ? [
        `${opts.dryRun ? 'Would change' : 'Changed'} ${p.changes.length} setting(s):`,
        ...p.changes.map(changeLine),
      ]
    : ['Nothing to change.'];
  if (opts.afterImport) {
    const keys = Object.keys(p.saved).filter((k) => env[k]?.trim());
    if (keys.length)
      lines.push(
        '',
        `${opts.dryRun ? 'After importing, remove' : 'Now remove'} these lines from the environment file (.env, or .env.prod on the server), then restart:`,
        `  ${keys.join(' ')}`,
        'Until then the environment keeps precedence and nothing changes.',
      );
  } else if (p.changes.length && !opts.dryRun) {
    const restart = p.changes.filter((c) => settingDef(c.key).apply === 'restart');
    lines.push(
      '',
      restart.length < p.changes.length
        ? 'A running server applies this at its next scheduled run; restart it to apply now.'
        : '',
      restart.length
        ? `Read at start-up only: ${restart.map((c) => c.key).join(', ')} (restart the server).`
        : '',
    );
  }
  out(
    lines
      .filter((l, i, all) => l !== '' || all[i - 1] !== '')
      .join('\n')
      .trimEnd(),
  );
  return 0;
}

const changeLine = (c: SettingChange) =>
  `  ${c.key}: ${c.from === null ? '(not saved)' : show(c.from)} → ${c.to === null ? '(not saved: environment or default)' : show(c.to)}`;

function renderList(view: SettingsView): string {
  const rows = view.settings.map(
    (s) =>
      `${s.key.padEnd(34)} ${show(s.value).padEnd(20)} ${s.source.padEnd(12)} ${s.apply}${s.source === 'environment' && s.saved !== null ? `   (dashboard: ${show(s.saved)})` : ''}`,
  );
  return [
    'Dashboard settings — precedence: environment > dashboard > default',
    `${'key'.padEnd(34)} ${'value'.padEnd(20)} ${'source'.padEnd(12)} applies`,
    ...rows,
    ...(view.environmentKeys.length
      ? [
          '',
          `${view.environmentKeys.length} setting(s) come from the environment (${
            view.settings.some((s) => s.source === 'environment' && s.saved !== s.value)
              ? '`settings:import-env` copies them into the dashboard; then'
              : 'their values are already saved in the dashboard:'
          } remove them from the environment file and restart):`,
          `  ${view.environmentKeys.join(' ')}`,
        ]
      : []),
    ...(view.problems.length
      ? [
          '',
          'The saved settings do not validate with this environment (the server would not start):',
          ...view.problems.map((i) => `  ! ${i.key}: ${i.message}`),
        ]
      : []),
  ].join('\n');
}

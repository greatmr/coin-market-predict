import {
  type AppConfig,
  ConfigError,
  SECRET_KEYS,
  SETTING_GROUPS,
  SETTING_KEYS,
  type SavedSettings,
  type SettingApply,
  type SettingKey,
  type SettingKind,
  type SettingValue,
  envSets,
  isSettingKey,
  loadConfig,
  normalizeSettingValue,
  settingDef,
  settingDefault,
} from '../../config/index.js';

/**
 * Pure rules of the dashboard settings, shared by the dashboard API and the CLI (which works even
 * when the server cannot start): what a save or an import changes, whether the result is a valid
 * configuration together with the environment, and how each setting is described.
 */

export interface SettingsInput {
  /** New values. null or an empty string clears an optional setting (MAX_QUOTE_AGE_MINUTES). */
  values?: Record<string, unknown>;
  /** Keys to remove from the dashboard: back to the environment value or the default. */
  reset?: string[];
}

export interface SettingIssue {
  key: string;
  message: string;
}

export interface SettingChange {
  key: SettingKey;
  /** null = not saved in the dashboard. */
  from: SettingValue | null;
  to: SettingValue | null;
}

export interface SettingsPlan {
  /** Every saved setting after the change. */
  saved: SavedSettings;
  changes: SettingChange[];
  issues: SettingIssue[];
}

export class SettingsError extends Error {
  constructor(readonly issues: SettingIssue[]) {
    super(issues.map((i) => `${i.key}: ${i.message}`).join('; '));
    this.name = 'SettingsError';
  }
}

const notASetting = (key: string): string =>
  (SECRET_KEYS as readonly string[]).includes(key)
    ? 'is a credential: it is set only in the server environment'
    : 'is not a dashboard setting (environment-only variables are listed in .env.example)';

const lockedByEnvironment = (key: string): string =>
  `is set in the server environment (${key} in .env / .env.prod), which takes precedence: remove it there and restart to manage it here`;

/** Set and reset dashboard settings. Keys the environment sets cannot be changed here. */
export function planSettings(
  env: NodeJS.ProcessEnv,
  current: SavedSettings,
  input: SettingsInput,
): SettingsPlan {
  const issues: SettingIssue[] = [];
  const next: SavedSettings = { ...current };
  const reset = new Set(input.reset ?? []);
  for (const [key, raw] of Object.entries(input.values ?? {})) {
    if (!isSettingKey(key)) issues.push({ key, message: notASetting(key) });
    else if (reset.has(key)) issues.push({ key, message: 'cannot be set and reset at once' });
    else if (envSets(env, key)) issues.push({ key, message: lockedByEnvironment(key) });
    else if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      if (settingDef(key).optional) delete next[key];
      else issues.push({ key, message: 'must not be empty (Reset returns it to the default)' });
    } else {
      const v = normalizeSettingValue(key, raw);
      if (v.ok) next[key] = v.value;
      else issues.push({ key, message: v.message });
    }
  }
  for (const key of reset) {
    if (isSettingKey(key)) delete next[key];
    else issues.push({ key, message: notASetting(key) });
  }
  return finish(env, current, next, issues);
}

/**
 * Copy every setting the environment sets into the dashboard. Nothing changes while the variables
 * stay in the environment (it takes precedence); once they are removed and the server restarted,
 * the dashboard holds the same values.
 */
export function planImport(env: NodeJS.ProcessEnv, current: SavedSettings): SettingsPlan {
  const issues: SettingIssue[] = [];
  const next: SavedSettings = { ...current };
  for (const key of SETTING_KEYS) {
    if (!envSets(env, key)) continue;
    const v = normalizeSettingValue(key, env[key]);
    if (v.ok) next[key] = v.value;
    else issues.push({ key, message: `the environment value ${v.message}` });
  }
  return finish(env, current, next, issues);
}

function finish(
  env: NodeJS.ProcessEnv,
  current: SavedSettings,
  next: SavedSettings,
  issues: SettingIssue[],
): SettingsPlan {
  if (!issues.length) issues.push(...validate(env, next));
  const changes = issues.length
    ? []
    : SETTING_KEYS.filter((k) => !Object.is(current[k] ?? null, next[k] ?? null)).map((k) => ({
        key: k,
        from: current[k] ?? null,
        to: next[k] ?? null,
      }));
  return { saved: next, changes, issues };
}

/** Problems of the whole configuration (environment + saved settings), cross-field rules included. */
export function validate(env: NodeJS.ProcessEnv, saved: SavedSettings): SettingIssue[] {
  try {
    loadConfig(env, saved);
    return [];
  } catch (err) {
    if (err instanceof ConfigError)
      return err.fields.map((f) => ({ key: f.key, message: f.message }));
    throw err;
  }
}

export type SettingSource = 'environment' | 'dashboard' | 'default';

export interface SavedSetting {
  value: SettingValue;
  updatedAt: Date;
  /** Who saved it last (the history keeps the name when the user is deleted). */
  updatedBy: string | null;
}

export interface SettingRow {
  key: SettingKey;
  group: string;
  label: string;
  help: string;
  kind: SettingKind;
  apply: SettingApply;
  unit: string | null;
  min: number | null;
  max: number | null;
  options: readonly string[] | null;
  format: string | null;
  optional: boolean;
  /** Where the value in force comes from (the environment takes precedence over the dashboard). */
  source: SettingSource;
  /** What the environment and the saved settings give: what the next start uses. */
  value: unknown;
  /** In force in this process now; differs from `value` while a change is pending. */
  running: unknown;
  /** Saved in the dashboard (also when the environment overrides it). */
  saved: SettingValue | null;
  /** The environment's text (settings are never secrets). */
  environment: string | null;
  default: unknown;
  /** restart = read at start-up only; run = waits for the pipeline run in progress or the next scheduled run. */
  pending: 'restart' | 'run' | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SettingsView {
  groups: typeof SETTING_GROUPS;
  settings: SettingRow[];
  /** Settings the environment sets; "Import from environment" copies them into the dashboard. */
  environmentKeys: SettingKey[];
  /** Saved settings that no longer validate with this environment (the server would not start). */
  problems: SettingIssue[];
  /** A saved change waits for the pipeline run in progress. */
  waitingForRun: boolean;
}

export function describeSettings(o: {
  env: NodeJS.ProcessEnv;
  saved: ReadonlyMap<SettingKey, SavedSetting>;
  /** The configuration in force in this process (the server), or null (the CLI). */
  running: AppConfig | null;
  waitingForRun: boolean;
}): SettingsView {
  const values: SavedSettings = {};
  for (const [key, s] of o.saved) values[key] = s.value;
  let effective: AppConfig | null = null;
  let problems: SettingIssue[] = [];
  try {
    effective = loadConfig(o.env, values);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    problems = err.fields.map((f) => ({ key: f.key, message: f.message }));
  }
  const settings = SETTING_KEYS.map((key): SettingRow => {
    const def = settingDef(key);
    const saved = o.saved.get(key) ?? null;
    const environment = envSets(o.env, key) ? String(o.env[key]).trim() : null;
    const value = effective ? effective[key] : null;
    const running = o.running ? o.running[key] : value;
    return {
      key,
      group: def.group,
      label: def.label,
      help: def.help,
      kind: def.kind,
      apply: def.apply,
      unit: def.unit ?? null,
      min: def.min ?? null,
      max: def.max ?? null,
      options: def.options ?? null,
      format: def.format ?? null,
      optional: def.optional ?? false,
      source: environment !== null ? 'environment' : saved ? 'dashboard' : 'default',
      value,
      running,
      saved: saved?.value ?? null,
      environment,
      default: settingDefault(key),
      pending:
        effective && !Object.is(running, value)
          ? def.apply === 'restart'
            ? 'restart'
            : 'run'
          : null,
      updatedAt: saved?.updatedAt.toISOString() ?? null,
      updatedBy: saved?.updatedBy ?? null,
    };
  });
  return {
    groups: SETTING_GROUPS,
    settings,
    environmentKeys: settings.filter((s) => s.source === 'environment').map((s) => s.key),
    problems,
    waitingForRun: o.waitingForRun,
  };
}

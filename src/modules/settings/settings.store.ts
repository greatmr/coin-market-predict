import { DataSource, type EntityManager } from 'typeorm';

import { redact, registerSecretsFromEnv } from '../../common/security/redact.js';
import { sleep } from '../../common/utils/time.js';

import {
  type SavedSettings,
  type SettingKey,
  type SettingValue,
  isSettingKey,
  resolveFileSecrets,
} from '../../config/index.js';

import { buildDataSourceOptions } from '../../database/typeorm-options.js';

import { AppSettingChange } from './entities/app-setting-change.entity.js';
import { AppSetting } from './entities/app-setting.entity.js';
import type { SettingChangeSource } from './settings.constants.js';
import type { SavedSetting, SettingChange } from './settings.plan.js';

/**
 * Database access for dashboard settings, on a plain `EntityManager` so the Nest service, the CLI
 * and the pre-boot loader share it. Raw SQL for reads: the pre-boot loader runs before the schema
 * metadata matters, and a database without M010 simply has no saved settings.
 */

export interface SettingsActor {
  /** The dashboard user, or null for the CLI. */
  userId: string | null;
  name: string;
  source: SettingChangeSource;
}

const UNDEFINED_TABLE = '42P01';

/** Saved values of the known settings (rows of a key no longer in the catalog are ignored). */
export async function readSavedValues(m: EntityManager): Promise<SavedSettings> {
  const rows = (await m.query(`SELECT key, value FROM app_setting`)) as Array<{
    key: string;
    value: SettingValue;
  }>;
  const out: SavedSettings = {};
  for (const r of rows) if (isSettingKey(r.key)) out[r.key] = r.value;
  return out;
}

/** Saved settings with when and by whom (the newest history entry) each was last changed. */
export async function readSavedSettings(m: EntityManager): Promise<Map<SettingKey, SavedSetting>> {
  const rows = (await m.query(
    `SELECT s.key, s.value, s.updated_at, h.changed_by_name
       FROM app_setting s
       LEFT JOIN LATERAL (
         SELECT changed_by_name FROM app_setting_change c
          WHERE c.key = s.key ORDER BY c.id DESC LIMIT 1
       ) h ON true`,
  )) as Array<{
    key: string;
    value: SettingValue;
    updated_at: Date;
    changed_by_name: string | null;
  }>;
  const out = new Map<SettingKey, SavedSetting>();
  for (const r of rows)
    if (isSettingKey(r.key))
      out.set(r.key, { value: r.value, updatedAt: r.updated_at, updatedBy: r.changed_by_name });
  return out;
}

/** Serialize writers (two owners, or the CLI next to the dashboard) for one transaction. */
export async function lockSettings(m: EntityManager): Promise<void> {
  await m.query(`LOCK TABLE app_setting IN SHARE ROW EXCLUSIVE MODE`);
}

/** Apply planned changes and record each in the append-only history. */
export async function writeChanges(
  m: EntityManager,
  changes: readonly SettingChange[],
  actor: SettingsActor,
): Promise<void> {
  if (!changes.length) return;
  const now = new Date();
  for (const c of changes) {
    if (c.to === null) await m.delete(AppSetting, { key: c.key });
    else
      await m.upsert(
        AppSetting,
        { key: c.key, value: c.to, updatedBy: actor.userId, updatedAt: now },
        ['key'],
      );
  }
  await m.insert(
    AppSettingChange,
    changes.map((c) => ({
      key: c.key,
      oldValue: c.from,
      newValue: c.to,
      source: actor.source,
      changedBy: actor.userId,
      changedByName: actor.name,
      changedAt: now,
    })),
  );
}

export interface SettingHistoryRow {
  id: number;
  key: string;
  oldValue: SettingValue | null;
  newValue: SettingValue | null;
  source: SettingChangeSource;
  changedBy: string;
  changedAt: string;
}

export async function readHistory(m: EntityManager, limit: number): Promise<SettingHistoryRow[]> {
  const rows = await m.getRepository(AppSettingChange).find({
    order: { id: 'DESC' },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    oldValue: r.oldValue,
    newValue: r.newValue,
    source: r.source,
    changedBy: r.changedByName,
    changedAt: r.changedAt.toISOString(),
  }));
}

/**
 * Pre-boot loader (server, CLI, MCP stdio): the saved settings, read with a short-lived connection
 * before the configuration is validated and Nest boots. A database without the settings table
 * (migrations pending) has none. Connection failures are retried, then reported: starting with the
 * environment alone could silently run, say, the synthetic source in production.
 */
export async function loadSavedSettings(
  env: NodeJS.ProcessEnv,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<SavedSettings> {
  const resolved = resolveFileSecrets(env);
  registerSecretsFromEnv(resolved);
  const attempts = Math.max(1, opts.attempts ?? 1);
  for (let attempt = 1; ; attempt++) {
    const ds = new DataSource({
      ...buildDataSourceOptions((key) => resolved[key]),
      entities: [],
      migrations: [],
      extra: { connectionTimeoutMillis: 10_000, max: 1 },
    });
    try {
      await ds.initialize();
      return await readSavedValues(ds.manager);
    } catch (err) {
      if ((err as { code?: unknown }).code === UNDEFINED_TABLE) return {};
      if (attempt >= attempts)
        throw new Error(`Could not read the dashboard settings from the database: ${redact(err)}`, {
          cause: err,
        });
      await sleep(opts.delayMs ?? 2_000);
    } finally {
      if (ds.isInitialized) await ds.destroy().catch(() => undefined);
    }
  }
}

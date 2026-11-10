import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  SECRET_KEYS,
  loadConfig,
  settingDefault,
  withSavedSettings,
} from './env.validation.js';
import {
  LIVE_SETTING_KEYS,
  SETTINGS,
  SETTING_GROUPS,
  SETTING_KEYS,
  type SettingKey,
  normalizeSettingValue,
  settingDef,
} from './settings.catalog.js';

const base = { DATABASE_URL: 'postgresql://coins:pw@localhost:5433/coins' } as NodeJS.ProcessEnv;

/** Cross-field partners, so a boundary check fails or passes for its own reason only. */
const partners: Partial<Record<SettingKey, Record<string, string>>> = {
  LBANK_PAIRS_REFRESH_DAYS: { LBANK_PAIRS_MAX_AGE_DAYS: '400' },
  LBANK_PAIRS_MAX_AGE_DAYS: { LBANK_PAIRS_REFRESH_DAYS: '1' },
};
const accepts = (key: SettingKey, value: string) => {
  try {
    loadConfig({ ...base, ...partners[key], [key]: value });
    return true;
  } catch (err) {
    if (err instanceof ConfigError) return false;
    throw err;
  }
};

describe('dashboard settings catalog', () => {
  it('holds no credential and nothing that decides the database, listener, proxy or file paths', () => {
    const envOnly = [
      ...SECRET_KEYS,
      'TELEGRAM_CHAT_ID',
      'NODE_ENV',
      'HOST',
      'PORT',
      'DATABASE_URL',
      'POSTGRES_HOST',
      'POSTGRES_PORT',
      'POSTGRES_USER',
      'POSTGRES_DB',
      'POSTGRES_SSL',
      'DB_LOGGING',
      'COOKIE_SECURE',
      'TRUST_PROXY',
      'TIER1_OVERRIDES_FILE',
      'TIER1_EXPORT_DIR',
    ];
    for (const key of envOnly) expect(SETTING_KEYS, key).not.toContain(key);
  });

  it('names a configuration key, a known group and an apply mode for every setting', () => {
    const cfg = loadConfig(base) as Record<string, unknown>;
    const groups = SETTING_GROUPS.map((g) => g.id) as string[];
    for (const key of SETTING_KEYS) {
      expect(cfg, key).toHaveProperty(key);
      expect(groups, key).toContain(settingDef(key).group);
      expect(['live', 'restart'], key).toContain(settingDef(key).apply);
    }
    // Built once at start-up: the data source and its adapters.
    expect(SETTING_KEYS.filter((k) => !LIVE_SETTING_KEYS.includes(k)).sort()).toEqual([
      'CMC_WEB_LISTING_PAGE_SIZE',
      'DATA_SOURCE',
      'SOURCE_MAX_MARKET_PAGES_PER_RUN',
    ]);
  });

  it('reports the schema default, and null for the derived maximum quote age', () => {
    const cfg = loadConfig(base);
    for (const key of SETTING_KEYS)
      if (key !== 'MAX_QUOTE_AGE_MINUTES') expect(settingDefault(key), key).toEqual(cfg[key]);
    expect(settingDefault('MAX_QUOTE_AGE_MINUTES')).toBeNull();
    expect(cfg.MAX_QUOTE_AGE_MINUTES).toBe(2 * cfg.CRAWL_EXPECTED_INTERVAL_MINUTES);
  });

  it('mirrors the schema bounds exactly (min / max inclusive, one step beyond refused)', () => {
    for (const key of SETTING_KEYS) {
      const def = settingDef(key);
      if (def.kind !== 'int' && def.kind !== 'number') continue;
      const step = def.kind === 'int' ? 1 : 0.5;
      if (def.min !== undefined) {
        expect(accepts(key, String(def.min)), `${key} = min`).toBe(true);
        expect(accepts(key, String(def.min - step)), `${key} < min`).toBe(false);
      }
      if (def.max !== undefined) {
        expect(accepts(key, String(def.max)), `${key} = max`).toBe(true);
        expect(accepts(key, String(def.max + step)), `${key} > max`).toBe(false);
      }
      if (def.kind === 'int') expect(accepts(key, String((def.min ?? 0) + 1.5)), key).toBe(false);
    }
  });

  it('mirrors the schema options of every choice', () => {
    for (const key of SETTING_KEYS) {
      const def = settingDef(key);
      if (def.kind === 'enum') {
        for (const option of def.options ?? []) {
          if (key === 'TELEGRAM_MODE' && option === 'live') continue; // needs credentials
          if (key === 'DATA_SOURCE' && (option === 'coinmarketcap' || option === 'coingecko'))
            continue; // need API keys
          expect(accepts(key, option), `${key}=${option}`).toBe(true);
        }
        expect(accepts(key, 'nope'), key).toBe(false);
      }
      if (def.kind === 'bool') {
        expect(accepts(key, 'true'), key).toBe(true);
        expect(accepts(key, 'false'), key).toBe(true);
      }
    }
  });

  it('validates the schedule (five-field cron, UTC) and the display time zone', () => {
    expect(accepts('PIPELINE_CRON', '7 * * * *')).toBe(true);
    expect(accepts('PIPELINE_CRON', '0 */2 * * 1-5')).toBe(true);
    expect(accepts('PIPELINE_CRON', '0 7 * * * *')).toBe(false); // seconds field
    expect(accepts('PIPELINE_CRON', '61 * * * *')).toBe(false);
    expect(accepts('PIPELINE_CRON', 'hourly')).toBe(false);
    expect(accepts('DISPLAY_TIMEZONE', 'Asia/Tehran')).toBe(true);
    expect(accepts('DISPLAY_TIMEZONE', 'UTC')).toBe(true);
    expect(accepts('DISPLAY_TIMEZONE', 'Mars/Olympus')).toBe(false);
  });

  it('normalizes input to one stored type per kind', () => {
    expect(normalizeSettingValue('TELEGRAM_QUEUE_ROWS', ' 12 ')).toEqual({ ok: true, value: 12 });
    expect(normalizeSettingValue('TELEGRAM_QUEUE_ROWS', 12)).toEqual({ ok: true, value: 12 });
    expect(normalizeSettingValue('TIER1_DAILY_MAX_MINUTES', '7.5')).toEqual({
      ok: true,
      value: 7.5,
    });
    expect(normalizeSettingValue('SCHEDULER_ENABLED', 'off')).toEqual({ ok: true, value: false });
    expect(normalizeSettingValue('SCHEDULER_ENABLED', true)).toEqual({ ok: true, value: true });
    expect(normalizeSettingValue('TELEGRAM_MODE', 'live')).toEqual({ ok: true, value: 'live' });
    expect(normalizeSettingValue('PIPELINE_CRON', ' 7 * * * * ')).toEqual({
      ok: true,
      value: '7 * * * *',
    });
    for (const [key, raw] of [
      ['TELEGRAM_QUEUE_ROWS', true], // a boolean is not a number
      ['TELEGRAM_QUEUE_ROWS', '1e3'],
      ['TELEGRAM_QUEUE_ROWS', '2.5'],
      ['TELEGRAM_QUEUE_ROWS', 31],
      ['TELEGRAM_QUEUE_ROWS', 0],
      ['SCHEDULER_ENABLED', 'maybe'],
      ['SCHEDULER_ENABLED', 1],
      ['TELEGRAM_MODE', 'LIVE'],
      ['PIPELINE_CRON', '   '],
      ['DISPLAY_TIMEZONE', 'x'.repeat(201)],
    ] as Array<[SettingKey, unknown]>)
      expect(normalizeSettingValue(key, raw).ok, `${key}=${String(raw)}`).toBe(false);
  });

  it('lets the environment win over a saved setting; an empty variable does not count', () => {
    const merged = withSavedSettings(
      { ...base, TELEGRAM_QUEUE_ROWS: '5', PIPELINE_CRON: ' ' },
      { TELEGRAM_QUEUE_ROWS: 9, PIPELINE_CRON: '17 * * * *', LBANK_PAIRS_REFRESH_DAYS: 20 },
    );
    expect(merged.TELEGRAM_QUEUE_ROWS).toBe('5');
    expect(merged.PIPELINE_CRON).toBe('17 * * * *');
    expect(merged.LBANK_PAIRS_REFRESH_DAYS).toBe(20);
    const unknown = withSavedSettings(base, { TELEGRAM_BOT_TOKEN: 'x' } as never);
    expect(unknown.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('derives the maximum quote age from a saved crawl interval and keeps cross-field rules', () => {
    expect(loadConfig(base, { CRAWL_EXPECTED_INTERVAL_MINUTES: 30 }).MAX_QUOTE_AGE_MINUTES).toBe(
      60,
    );
    try {
      loadConfig(base, { LBANK_PAIRS_MAX_AGE_DAYS: 10 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issue = (err as ConfigError).fields[0]!;
      expect(issue).toMatchObject({ key: 'LBANK_PAIRS_MAX_AGE_DAYS', fromDashboard: true });
      // The start-up message says where the value lives and how to undo it.
      expect((err as Error).message).toMatch(
        /dashboard settings.*settings:reset LBANK_PAIRS_MAX_AGE_DAYS/,
      );
    }
  });

  it('describes every setting for the dashboard', () => {
    for (const key of SETTING_KEYS) {
      expect(SETTINGS[key].label.length, key).toBeGreaterThan(3);
      expect(SETTINGS[key].help.length, key).toBeGreaterThan(20);
    }
  });
});

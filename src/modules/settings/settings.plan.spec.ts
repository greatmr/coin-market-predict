import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../config/index.js';

import { type SavedSetting, describeSettings, planImport, planSettings } from './settings.plan.js';

const env = {
  DATABASE_URL: 'postgresql://coins:pw@localhost:5433/coins',
  TELEGRAM_MODE: 'dry_run',
} as NodeJS.ProcessEnv;

const keysOf = (issues: Array<{ key: string }>) => issues.map((i) => i.key);

describe('planSettings', () => {
  it('normalizes values and lists only real changes', () => {
    const p = planSettings(
      env,
      { TELEGRAM_QUEUE_ROWS: 10 },
      {
        values: {
          TELEGRAM_QUEUE_ROWS: '10',
          PIPELINE_CRON: ' 17 * * * * ',
          SCHEDULER_ENABLED: 'off',
        },
      },
    );
    expect(p.issues).toEqual([]);
    expect(p.saved).toEqual({
      TELEGRAM_QUEUE_ROWS: 10,
      PIPELINE_CRON: '17 * * * *',
      SCHEDULER_ENABLED: false,
    });
    expect(p.changes).toEqual([
      { key: 'SCHEDULER_ENABLED', from: null, to: false },
      { key: 'PIPELINE_CRON', from: null, to: '17 * * * *' },
    ]);
  });

  it('refuses credentials, unknown keys and keys the environment sets', () => {
    const p = planSettings(
      env,
      {},
      {
        values: {
          TELEGRAM_BOT_TOKEN: 'x',
          HOST: '0.0.0.0',
          TELEGRAM_MODE: 'live',
          DISPLAY_TIMEZONE: 'UTC',
        },
      },
    );
    expect(p.changes).toEqual([]);
    expect(p.issues).toEqual([
      { key: 'TELEGRAM_BOT_TOKEN', message: expect.stringMatching(/credential/) },
      { key: 'HOST', message: expect.stringMatching(/not a dashboard setting/) },
      { key: 'TELEGRAM_MODE', message: expect.stringMatching(/server environment.*precedence/) },
    ]);
  });

  it('checks the whole configuration, cross-field rules included, and saves nothing on error', () => {
    const lbank = planSettings(env, {}, { values: { LBANK_PAIRS_MAX_AGE_DAYS: 20 } });
    expect(lbank.issues).toEqual([
      { key: 'LBANK_PAIRS_MAX_AGE_DAYS', message: 'must be at least LBANK_PAIRS_REFRESH_DAYS' },
    ]);
    expect(lbank.changes).toEqual([]);
    // Live Telegram needs the token and chat id, which only the environment can provide.
    const noToken = planSettings(
      { DATABASE_URL: env.DATABASE_URL },
      {},
      {
        values: { TELEGRAM_MODE: 'live' },
      },
    );
    expect(keysOf(noToken.issues)).toEqual(['TELEGRAM_MODE']);
    const withToken = planSettings(
      {
        DATABASE_URL: env.DATABASE_URL,
        TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
        TELEGRAM_CHAT_ID: '42',
      },
      {},
      { values: { TELEGRAM_MODE: 'live' } },
    );
    expect(withToken.issues).toEqual([]);
    // A source that needs an API key the environment lacks.
    expect(keysOf(planSettings(env, {}, { values: { DATA_SOURCE: 'coingecko' } }).issues)).toEqual([
      'DATA_SOURCE',
    ]);
    expect(
      keysOf(planSettings(env, {}, { values: { PIPELINE_CRON: '* * * * * *' } }).issues),
    ).toEqual(['PIPELINE_CRON']);
  });

  it('resets to the environment or the default, and also validates a reset', () => {
    const saved = { LBANK_PAIRS_REFRESH_DAYS: 50, LBANK_PAIRS_MAX_AGE_DAYS: 60 };
    const p = planSettings(env, saved, { reset: ['LBANK_PAIRS_MAX_AGE_DAYS'] });
    // Back to the default 35 days would be below the saved 50-day refresh interval.
    expect(keysOf(p.issues)).toEqual(['LBANK_PAIRS_MAX_AGE_DAYS']);
    const both = planSettings(env, saved, {
      reset: ['LBANK_PAIRS_MAX_AGE_DAYS', 'LBANK_PAIRS_REFRESH_DAYS'],
    });
    expect(both.issues).toEqual([]);
    expect(both.saved).toEqual({});
    expect(both.changes.map((c) => [c.key, c.to])).toEqual([
      ['LBANK_PAIRS_REFRESH_DAYS', null],
      ['LBANK_PAIRS_MAX_AGE_DAYS', null],
    ]);
    expect(planSettings(env, {}, { reset: ['MCP_READ_TOKEN'] }).issues[0]!.message).toMatch(
      /credential/,
    );
    expect(
      keysOf(
        planSettings(
          env,
          {},
          { values: { TELEGRAM_QUEUE_ROWS: 5 }, reset: ['TELEGRAM_QUEUE_ROWS'] },
        ).issues,
      ),
    ).toEqual(['TELEGRAM_QUEUE_ROWS']);
  });

  it('clears an optional setting with an empty value but refuses empty required ones', () => {
    const p = planSettings(
      env,
      { MAX_QUOTE_AGE_MINUTES: 90 },
      { values: { MAX_QUOTE_AGE_MINUTES: '' } },
    );
    expect(p.issues).toEqual([]);
    expect(p.changes).toEqual([{ key: 'MAX_QUOTE_AGE_MINUTES', from: 90, to: null }]);
    expect(keysOf(planSettings(env, {}, { values: { PIPELINE_CRON: null } }).issues)).toEqual([
      'PIPELINE_CRON',
    ]);
  });
});

describe('planImport', () => {
  it('copies the environment values into the dashboard without changing what is in force', () => {
    const withSettings = {
      ...env,
      SCHEDULER_ENABLED: 'true',
      PIPELINE_CRON: '7 * * * *',
      TELEGRAM_QUEUE_ROWS: '10',
      MAX_QUOTE_AGE_MINUTES: ' ',
    } as NodeJS.ProcessEnv;
    const p = planImport(withSettings, { TELEGRAM_QUEUE_ROWS: 10, DISPLAY_TIMEZONE: 'UTC' });
    expect(p.issues).toEqual([]);
    expect(p.changes).toEqual([
      { key: 'SCHEDULER_ENABLED', from: null, to: true },
      { key: 'PIPELINE_CRON', from: null, to: '7 * * * *' },
      { key: 'TELEGRAM_MODE', from: null, to: 'dry_run' },
    ]);
    expect(loadConfig(withSettings, p.saved)).toEqual(
      loadConfig(withSettings, { DISPLAY_TIMEZONE: 'UTC' }),
    );
    expect(planImport(withSettings, p.saved).changes).toEqual([]);
  });
});

describe('describeSettings', () => {
  const at = new Date('2026-11-10T12:00:00Z');
  const saved = (entries: Record<string, unknown>) =>
    new Map(
      Object.entries(entries).map(([k, value]) => [
        k,
        { value, updatedAt: at, updatedBy: 'owner' },
      ]),
    ) as Map<never, SavedSetting>;

  it('says where each value comes from and what is waiting', () => {
    const running = loadConfig(env);
    const v = describeSettings({
      env,
      saved: saved({
        DATA_SOURCE: 'coinmarketcap_web',
        TELEGRAM_QUEUE_ROWS: 5,
        TELEGRAM_MODE: 'live',
      }),
      running,
      waitingForRun: true,
    });
    const row = (key: string) => v.settings.find((s) => s.key === key)!;
    expect(row('TELEGRAM_MODE')).toMatchObject({
      source: 'environment',
      value: 'dry_run',
      saved: 'live',
      environment: 'dry_run',
      pending: null,
    });
    expect(row('DATA_SOURCE')).toMatchObject({
      source: 'dashboard',
      value: 'coinmarketcap_web',
      running: 'fixture',
      pending: 'restart',
      updatedBy: 'owner',
      updatedAt: at.toISOString(),
    });
    expect(row('TELEGRAM_QUEUE_ROWS')).toMatchObject({ value: 5, running: 10, pending: 'run' });
    expect(row('PIPELINE_CRON')).toMatchObject({
      source: 'default',
      value: '7 * * * *',
      default: '7 * * * *',
      pending: null,
    });
    expect(row('MAX_QUOTE_AGE_MINUTES')).toMatchObject({
      value: 120,
      default: null,
      optional: true,
    });
    expect(v.environmentKeys).toEqual(['TELEGRAM_MODE']);
    expect(v.problems).toEqual([]);
    expect(v.waitingForRun).toBe(true);
  });

  it('reports saved settings that no longer validate with the environment', () => {
    const v = describeSettings({
      env: { DATABASE_URL: env.DATABASE_URL },
      saved: saved({ TELEGRAM_MODE: 'live' }),
      running: null,
      waitingForRun: false,
    });
    expect(keysOf(v.problems)).toEqual(['TELEGRAM_MODE']);
    expect(v.settings.every((s) => s.pending === null)).toBe(true);
  });
});

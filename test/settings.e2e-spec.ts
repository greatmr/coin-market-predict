import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { LiveConfig, loadConfig } from '../src/config/index.js';
import { UsersService } from '../src/modules/auth/users.service.js';
import { PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import { AppSettingChange } from '../src/modules/settings/entities/app-setting-change.entity.js';
import { AppSetting } from '../src/modules/settings/entities/app-setting.entity.js';
import { settingsCommand } from '../src/modules/settings/settings.cli.js';
import { SettingsError } from '../src/modules/settings/settings.plan.js';
import { SettingsService } from '../src/modules/settings/settings.service.js';
import { loadSavedSettings } from '../src/modules/settings/settings.store.js';

import { makeApp, resetDb, testEnv } from './utils/helpers.js';

let ctx: Awaited<ReturnType<typeof makeApp>>;
let settings: SettingsService;
let owner: { userId: string; name: string; source: 'dashboard' };

beforeAll(async () => {
  // The test environment sets DATA_SOURCE, SCHEDULER_ENABLED and TELEGRAM_MODE: those are locked.
  ctx = await makeApp();
  settings = ctx.app.get(SettingsService);
});
afterAll(async () => ctx.app.close());
beforeEach(async () => {
  await resetDb(ctx.db);
  await settings.refresh(); // back to the environment and defaults
  const users = ctx.app.get(UsersService);
  await users.ensureOwner();
  owner = { userId: (await users.findByUsername('owner'))!.id, name: 'owner', source: 'dashboard' };
});

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof SettingsError) return err.issues;
    throw err;
  }
  throw new Error('expected a SettingsError');
};
const quiet = () => undefined;

describe('dashboard settings', () => {
  it('saves, applies to the running process at once and records who changed what', async () => {
    const r = await settings.save(
      {
        values: {
          PIPELINE_CRON: '17 * * * *',
          LBANK_PAIRS_MAX_AGE_DAYS: '40',
          DISPLAY_TIMEZONE: 'UTC',
        },
      },
      owner,
    );
    expect(r.outcome).toBe('applied');
    expect(r.changes.map((c) => c.key)).toEqual([
      'PIPELINE_CRON',
      'LBANK_PAIRS_MAX_AGE_DAYS',
      'DISPLAY_TIMEZONE',
    ]);
    expect([
      ctx.cfg.PIPELINE_CRON,
      ctx.cfg.LBANK_PAIRS_MAX_AGE_DAYS,
      ctx.cfg.DISPLAY_TIMEZONE,
    ]).toEqual(['17 * * * *', 40, 'UTC']);
    const rows = await ctx.repo(AppSetting).find({ order: { key: 'ASC' } });
    expect(rows.map((s) => [s.key, s.value, s.updatedBy])).toEqual([
      ['DISPLAY_TIMEZONE', 'UTC', owner.userId],
      ['LBANK_PAIRS_MAX_AGE_DAYS', 40, owner.userId],
      ['PIPELINE_CRON', '17 * * * *', owner.userId],
    ]);
    const history = await ctx.repo(AppSettingChange).find({ order: { id: 'ASC' } });
    expect(history.map((h) => [h.key, h.oldValue, h.newValue, h.source, h.changedByName])).toEqual([
      ['PIPELINE_CRON', null, '17 * * * *', 'dashboard', 'owner'],
      ['LBANK_PAIRS_MAX_AGE_DAYS', null, 40, 'dashboard', 'owner'],
      ['DISPLAY_TIMEZONE', null, 'UTC', 'dashboard', 'owner'],
    ]);
    const row = r.view.settings.find((s) => s.key === 'PIPELINE_CRON')!;
    expect(row).toMatchObject({
      source: 'dashboard',
      value: '17 * * * *',
      running: '17 * * * *',
      pending: null,
      updatedBy: 'owner',
    });
    // The next start reads them back before validating the configuration.
    const saved = await loadSavedSettings(testEnv());
    expect(saved).toEqual({
      DISPLAY_TIMEZONE: 'UTC',
      LBANK_PAIRS_MAX_AGE_DAYS: 40,
      PIPELINE_CRON: '17 * * * *',
    });
    expect(loadConfig(testEnv(), saved).PIPELINE_CRON).toBe('17 * * * *');
    // Saving the same values again changes nothing and records nothing.
    const again = await settings.save({ values: { PIPELINE_CRON: '17 * * * *' } }, owner);
    expect([again.outcome, again.changes]).toEqual(['unchanged', []]);
    expect(await ctx.repo(AppSettingChange).count()).toBe(3);
  });

  it('refuses an invalid save as a whole: nothing stored, nothing applied', async () => {
    const issues = await rejection(
      settings.save({ values: { PIPELINE_CRON: 'every hour', TELEGRAM_QUEUE_ROWS: 5 } }, owner),
    );
    expect(issues.map((i) => i.key)).toEqual(['PIPELINE_CRON']);
    expect(
      (await rejection(settings.save({ values: { LBANK_PAIRS_MAX_AGE_DAYS: 10 } }, owner))).map(
        (i) => i.key,
      ),
    ).toEqual(['LBANK_PAIRS_MAX_AGE_DAYS']);
    // The environment sets it: only the environment can change it.
    expect(
      (await rejection(settings.save({ values: { TELEGRAM_MODE: 'disabled' } }, owner)))[0]!
        .message,
    ).toMatch(/server environment/);
    expect(await ctx.repo(AppSetting).count()).toBe(0);
    expect(await ctx.repo(AppSettingChange).count()).toBe(0);
    expect(ctx.cfg.TELEGRAM_QUEUE_ROWS).toBe(10);
  });

  it('keeps a start-up setting for the next start and says so', async () => {
    const r = await settings.save({ values: { CMC_WEB_LISTING_PAGE_SIZE: 5000 } }, owner);
    expect(r.restartRequired).toEqual(['CMC_WEB_LISTING_PAGE_SIZE']);
    expect(ctx.cfg.CMC_WEB_LISTING_PAGE_SIZE).toBe(10_000);
    expect(r.view.settings.find((s) => s.key === 'CMC_WEB_LISTING_PAGE_SIZE')).toMatchObject({
      value: 5000,
      running: 10_000,
      pending: 'restart',
    });
    expect(
      loadConfig(testEnv(), await loadSavedSettings(testEnv())).CMC_WEB_LISTING_PAGE_SIZE,
    ).toBe(5000);
  });

  it('holds a change saved during a pipeline run until the run ends', async () => {
    const live = ctx.app.get(LiveConfig);
    const run = ctx.app.get(PipelineService).runSlot();
    const deadline = Date.now() + 10_000;
    while (!live.held && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(live.held).toBe(true);
    const r = await settings.save({ values: { TELEGRAM_QUEUE_ROWS: 4 } }, owner);
    expect(r.outcome).toBe('deferred');
    expect(ctx.cfg.TELEGRAM_QUEUE_ROWS).toBe(10);
    expect(r.view.waitingForRun).toBe(true);
    expect(r.view.settings.find((s) => s.key === 'TELEGRAM_QUEUE_ROWS')).toMatchObject({
      value: 4,
      running: 10,
      pending: 'run',
    });
    expect((await run).status).not.toBe('skipped');
    expect([ctx.cfg.TELEGRAM_QUEUE_ROWS, live.held, live.hasPending]).toEqual([4, false, false]);
  });

  it('imports the values the environment sets without changing what is in force', async () => {
    const before = { ...ctx.cfg };
    const r = await settings.importEnvironment({ userId: owner.userId, name: 'owner' });
    expect(r.changes.map((c) => [c.key, c.to])).toEqual([
      ['DATA_SOURCE', 'fixture'],
      ['SCHEDULER_ENABLED', false],
      ['TELEGRAM_MODE', 'dry_run'],
    ]);
    expect({ ...ctx.cfg }).toEqual(before);
    expect(new Set((await ctx.repo(AppSettingChange).find()).map((h) => h.source))).toEqual(
      new Set(['import_env']),
    );
    expect(
      (await settings.importEnvironment({ userId: owner.userId, name: 'owner' })).outcome,
    ).toBe('unchanged');
  });

  it('takes changes saved with the CLI at the next refresh (each scheduled run)', async () => {
    const out: string[] = [];
    const say = (t: string) => void out.push(t);
    expect(
      await settingsCommand('settings:set', ['TELEGRAM_QUEUE_ROWS', '6'], testEnv(), say),
    ).toBe(0);
    expect(out.join('\n')).toMatch(/Changed 1 setting/);
    expect(ctx.cfg.TELEGRAM_QUEUE_ROWS).toBe(10);
    await settings.refresh();
    expect(ctx.cfg.TELEGRAM_QUEUE_ROWS).toBe(6);
    const [h] = await ctx.repo(AppSettingChange).find();
    expect([h!.source, h!.changedBy, h!.changedByName]).toEqual(['cli', null, 'cli']);

    out.length = 0;
    expect(await settingsCommand('settings:set', ['TELEGRAM_MODE', 'live'], testEnv(), say)).toBe(
      2,
    );
    expect(out.join('\n')).toMatch(
      /Nothing was saved[\s\S]*TELEGRAM_MODE: is set in the server environment/,
    );
    // A cron expression with spaces may be passed unquoted.
    expect(
      await settingsCommand(
        'settings:set',
        ['PIPELINE_CRON', '0', '*', '*', '*', '*'],
        testEnv(),
        quiet,
      ),
    ).toBe(0);
    expect((await loadSavedSettings(testEnv())).PIPELINE_CRON).toBe('0 * * * *');

    out.length = 0;
    expect(await settingsCommand('settings:list', [], testEnv(), say)).toBe(0);
    expect(out.join('\n')).toMatch(/TELEGRAM_QUEUE_ROWS\s+6\s+dashboard\s+live/);
    expect(out.join('\n')).toMatch(/TELEGRAM_MODE\s+dry_run\s+environment/);

    out.length = 0;
    expect(await settingsCommand('settings:import-env', ['--dry-run'], testEnv(), say)).toBe(0);
    expect(out.join('\n')).toMatch(/Would change 3 setting[\s\S]*remove these lines/);
    expect(await ctx.repo(AppSetting).count()).toBe(2); // dry run: nothing written

    expect(await settingsCommand('settings:reset', ['TELEGRAM_QUEUE_ROWS'], testEnv(), quiet)).toBe(
      0,
    );
    await settings.refresh();
    expect(ctx.cfg.TELEGRAM_QUEUE_ROWS).toBe(10);
  });

  it('keeps the history append-only, also when the user who made a change is deleted', async () => {
    const users = ctx.app.get(UsersService);
    const ana = await users.create(
      { username: 'ana', role: 'owner', password: 'owner-pass-123' },
      { temporary: false },
    );
    await settings.save(
      { values: { TELEGRAM_QUEUE_ROWS: 8 } },
      { userId: ana.id, name: 'ana', source: 'dashboard' },
    );
    await users.remove(owner.userId, ana.id);
    const [h] = await ctx.repo(AppSettingChange).find();
    expect([h!.changedBy, h!.changedByName]).toEqual([null, 'ana']);
    expect(
      (await ctx.repo(AppSetting).findOneByOrFail({ key: 'TELEGRAM_QUEUE_ROWS' })).updatedBy,
    ).toBeNull();
    await expect(ctx.db.query(`UPDATE app_setting_change SET new_value = '9'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(ctx.db.query(`DELETE FROM app_setting_change`)).rejects.toThrow(/append-only/);
  });
});

describe('the schedule follows the settings', () => {
  it('starts, reschedules and stops the cron jobs without a restart', async () => {
    // An environment that leaves the scheduler to the dashboard, saved as off (and no catch-up run).
    const { SCHEDULER_ENABLED: _locked, ...rest } = testEnv();
    const env = rest as NodeJS.ProcessEnv;
    await settingsCommand('settings:set', ['SCHEDULER_ENABLED', 'false'], env, quiet);
    await settingsCommand('settings:set', ['MISSED_RUN_POLICY', 'skip'], env, quiet);
    const cfg = loadConfig(env, await loadSavedSettings(env));
    const mod = await Test.createTestingModule({
      imports: [AppModule.forRoot(cfg, { http: false, inputs: { env, forced: {} } })],
    }).compile();
    mod.useLogger(false);
    await mod.init();
    try {
      const registry = mod.get(SchedulerRegistry);
      const svc = mod.get(SettingsService);
      const cron = () =>
        registry.doesExist('cron', 'hourly-pipeline')
          ? String(registry.getCronJob('hourly-pipeline').cronTime.source)
          : null;
      expect(cron()).toBeNull();
      await svc.save({ values: { SCHEDULER_ENABLED: true } }, owner);
      expect([cron(), registry.doesExist('cron', 'telegram-delivery')]).toEqual([
        '7 * * * *',
        true,
      ]);
      await svc.save({ values: { PIPELINE_CRON: '17 * * * *' } }, owner);
      expect(cron()).toBe('17 * * * *');
      await svc.save({ values: { SCHEDULER_ENABLED: false } }, owner);
      expect([cron(), registry.doesExist('cron', 'telegram-delivery')]).toEqual([null, false]);
    } finally {
      await mod.close();
    }
  });
});

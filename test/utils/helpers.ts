import { Test } from '@nestjs/testing';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';

import { AppModule } from '../../src/app.module.js';
import { type AppConfig, loadConfig } from '../../src/config/index.js';
import { TELEGRAM_FETCH } from '../../src/modules/telegram/telegram.service.js';

import { testDbUrl } from './test-database.js';

export { testDbUrl } from './test-database.js';

/**
 * The environment of e2e tests: the test database, fixture data, Telegram dry-run, no scheduler.
 * Never `process.env` (it may hold the operator's live settings), and these keys are therefore
 * locked against dashboard settings in every test app.
 */
export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: testDbUrl(),
    SCHEDULER_ENABLED: 'false',
    TELEGRAM_MODE: 'dry_run',
    DATA_SOURCE: 'fixture',
    TIER1_EXPORT_DIR: 'var/test-exports',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(testEnv(overrides));
}

/** The application context without HTTP (as the CLI builds it), against the test database. */
export async function makeApp(overrides: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const env = testEnv(overrides);
  const cfg = loadConfig(env);
  const builder = Test.createTestingModule({
    imports: [AppModule.forRoot(cfg, { http: false, inputs: { env, forced: {} } })],
  });
  if (fetchImpl) builder.overrideProvider(TELEGRAM_FETCH).useValue(fetchImpl);
  const mod = await builder.compile();
  mod.useLogger(false);
  await mod.init();
  const db = mod.get(DataSource);
  return {
    app: mod,
    cfg,
    db,
    repo: <T extends ObjectLiteral>(entity: EntityTarget<T>) => db.getRepository(entity),
  };
}

/** Empty every table (the migrations table excepted). Only ever the test database (`testDbUrl`). */
export async function resetDb(db: DataSource) {
  const rows = (await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
  )) as Array<{ tablename: string }>;
  if (rows.length)
    await db.query(
      `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
}

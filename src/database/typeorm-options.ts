import pg from 'pg';
import type { DataSourceOptions } from 'typeorm';

import { POSTGRES_REQUIRED } from '../config/env.validation.js';

import { ENTITIES } from './entities.js';
import { MIGRATIONS } from './migrations/index.js';
import { PostgresNamingStrategy } from './naming.strategy.js';

export type PostgresDataSourceOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/** Reads one configuration value (the validated `AppConfig`, or `process.env` for the TypeORM CLI). */
export type ConfigGetter = (key: string) => string | number | boolean | null | undefined;

// `date` columns hold UTC calendar days: keep the 'YYYY-MM-DD' text instead of a local-midnight Date.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

/**
 * The one place connection options are built, shared by the Nest application
 * (`database.module.ts`) and the TypeORM CLI (`data-source.ts`), so the two can never disagree about
 * entities, migrations or the connection.
 *
 * `synchronize` and `migrationsRun` are the literal `false` and deliberately not configurable: the
 * schema changes only through the reviewed migration files in `src/database/migrations`, applied
 * with `npm run db:migrate` (or `RUN_MIGRATIONS=true` in Docker). Booting never alters a database.
 */
export function buildDataSourceOptions(get: ConfigGetter): PostgresDataSourceOptions {
  const str = (key: string): string | undefined => {
    const v = get(key);
    return v === null || v === undefined || v === '' ? undefined : String(v);
  };
  const url = str('DATABASE_URL');
  if (!url) {
    const missing = POSTGRES_REQUIRED.filter((key) => !str(key));
    if (missing.length)
      throw new Error(`Missing database configuration: set DATABASE_URL or ${missing.join(', ')}`);
  }
  const port = str('POSTGRES_PORT');
  const ssl = ['1', 'true', 'yes', 'on'].includes((str('POSTGRES_SSL') ?? '').toLowerCase());
  const logging = ['1', 'true', 'yes', 'on'].includes((str('DB_LOGGING') ?? '').toLowerCase());
  return {
    type: 'postgres',
    ...(url
      ? { url }
      : {
          host: str('POSTGRES_HOST'),
          port: port ? Number(port) : undefined,
          username: str('POSTGRES_USER'),
          password: str('POSTGRES_PASSWORD'),
          database: str('POSTGRES_DB'),
        }),
    // Verified TLS: node-postgres `ssl: true` requires a server certificate from a trusted CA. A
    // connection that must skip verification says so explicitly: `sslmode=no-verify` in DATABASE_URL.
    ...(ssl ? { ssl: true } : {}),
    applicationName: 'coins-predicts',
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsRun: false,
    synchronize: false,
    // gen_random_uuid() is built into PostgreSQL ≥ 13; no extension is created on connect.
    installExtensions: false,
    uuidExtension: 'pgcrypto',
    namingStrategy: new PostgresNamingStrategy(),
    logging: logging ? ['query', 'error', 'schema', 'migration'] : false,
    extra: { connectionTimeoutMillis: 10_000, max: 10 },
  };
}

import pg from 'pg';
import { DataSource } from 'typeorm';

import { MIGRATIONS } from '../../src/database/migrations/index.js';
import { PostgresNamingStrategy } from '../../src/database/naming.strategy.js';

import { testDbUrl } from './test-database.js';

/**
 * Vitest globalSetup for the e2e project: create the dedicated test database if needed and apply
 * the committed migrations (never `synchronize`). A test database still holding the retired Prisma
 * schema is emptied first — only ever the test database (see `testDbUrl`).
 */
export default async function setup() {
  const url = testDbUrl();
  const name = new URL(url).pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  admin.search = '';
  const server = new pg.Client({ connectionString: admin.toString() });
  try {
    await server.connect();
  } catch (err) {
    throw new Error(
      `Test database server unreachable (start it with \`docker compose up -d postgres\`): ${(err as Error).message}`,
      { cause: err },
    );
  }
  const exists = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount === 0) await server.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  await server.end();

  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const legacy = await db.query(
    "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations'",
  );
  if (legacy.rowCount) await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.end();

  const dataSource = new DataSource({
    type: 'postgres',
    url,
    migrations: MIGRATIONS,
    namingStrategy: new PostgresNamingStrategy(),
    logging: false,
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'all' });
  } finally {
    await dataSource.destroy();
  }
}

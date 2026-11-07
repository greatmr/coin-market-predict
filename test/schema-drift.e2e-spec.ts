import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDataSourceOptions } from '../src/database/typeorm-options.js';

import { testDbUrl } from './utils/test-database.js';

/**
 * The migrated database and the entities must describe the same schema: TypeORM's schema builder,
 * pointed at the freshly migrated test database, must find nothing to change (no column, type,
 * default, nullability, enum, index, unique, check or foreign key difference).
 */
let dataSource: DataSource;

beforeAll(async () => {
  dataSource = new DataSource(
    buildDataSourceOptions((key) => (key === 'DATABASE_URL' ? testDbUrl() : undefined)),
  );
  await dataSource.initialize();
});
afterAll(async () => dataSource.destroy());

describe('database schema', () => {
  it('has every committed migration applied', async () => {
    expect(await dataSource.showMigrations()).toBe(false);
  });

  it('matches the entities exactly (no drift between migrations and entities)', async () => {
    const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
    expect(upQueries.map((q) => q.query)).toEqual([]);
  });

  it('uses snake_case tables and PostgreSQL-style constraint names', async () => {
    const tables: Array<{ tablename: string }> = await dataSource.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations' ORDER BY tablename`,
    );
    expect(tables.map((t) => t.tablename)).toEqual(
      dataSource.entityMetadatas.map((m) => m.tableName).sort(),
    );
    for (const t of tables) expect(t.tablename).toMatch(/^[a-z][a-z0-9_]*$/);
    const fks: Array<{ conname: string }> = await dataSource.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
    );
    for (const fk of fks) expect(fk.conname).toMatch(/_fkey$/);
  });
});

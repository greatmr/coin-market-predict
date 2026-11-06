import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ENTITIES } from './entities.js';
import { MIGRATIONS } from './migrations/index.js';
import { PostgresNamingStrategy } from './naming.strategy.js';
import { buildDataSourceOptions } from './typeorm-options.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

const base: Record<string, string> = {
  POSTGRES_HOST: 'db.example.com',
  POSTGRES_USER: 'coins',
  POSTGRES_PASSWORD: 'pw-not-echoed',
  POSTGRES_DB: 'coins',
};
const from = (env: Record<string, string | boolean>) => (key: string) => env[key];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('buildDataSourceOptions', () => {
  it('never synchronizes, runs migrations or installs extensions at boot', () => {
    const options = buildDataSourceOptions(from({ ...base, NODE_ENV: 'development' }));
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);
    expect(options.installExtensions).toBe(false);
    expect(options.namingStrategy).toBeInstanceOf(PostgresNamingStrategy);
    expect(options.entities).toBe(ENTITIES);
    expect(options.migrations).toBe(MIGRATIONS);
  });

  it('names every missing variable without echoing values', () => {
    expect(() => buildDataSourceOptions(() => undefined)).toThrow(
      'POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB',
    );
    try {
      buildDataSourceOptions(from({ POSTGRES_PASSWORD: 'pw-not-echoed' }));
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toMatch(/POSTGRES_HOST, POSTGRES_USER, POSTGRES_DB/);
      expect(String(e)).not.toMatch(/pw-not-echoed/);
    }
  });

  it('prefers DATABASE_URL over the POSTGRES_* variables', () => {
    const url = 'postgresql://coins:pw@127.0.0.1:5433/coins_test';
    const options = buildDataSourceOptions(from({ ...base, DATABASE_URL: url }));
    expect(options.url).toBe(url);
    expect(options.host).toBeUndefined();
    expect(options.password).toBeUndefined();
  });

  it('parses the port and enables verified TLS only when asked', () => {
    const plain = buildDataSourceOptions(from(base));
    expect([plain.host, plain.port, plain.database]).toEqual([
      'db.example.com',
      undefined,
      'coins',
    ]);
    expect(plain.ssl).toBeUndefined();

    // The CLI passes strings from process.env; the application passes the validated booleans.
    for (const flag of ['true', true]) {
      const tls = buildDataSourceOptions(
        from({ ...base, POSTGRES_PORT: '6543', POSTGRES_SSL: flag }),
      );
      expect(tls.port).toBe(6543);
      expect(tls.ssl).toBe(true); // node-postgres verifies the server certificate
    }
  });
});

describe('explicit entity and migration registries', () => {
  it('registers every @Entity class exactly once', () => {
    // The class an @Entity decorates is the next one declared (@Unique / @Index may sit between).
    const declared = sourceFiles(join(SRC, 'modules'))
      .filter((f) => f.endsWith('.entity.ts'))
      .flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/@Entity\(.*?\)[\s\S]*?\bexport class (\w+)/g)].map(
          ([, name]) => name,
        ),
      );
    const registered = ENTITIES.map((e) => e.name);
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...declared].sort());
  });

  it('registers every migration file, in timestamp order', () => {
    const files = readdirSync(join(SRC, 'database', 'migrations'))
      .filter((f) => /^\d{13}-\w+\.ts$/.test(f))
      .sort();
    // TypeORM orders by the 13-digit timestamp at the end of the class name.
    const expected = files.map((f) => {
      const [, stamp, name] = /^(\d{13})-(\w+)\.ts$/.exec(f)!;
      return `${name}${stamp}`;
    });
    expect(MIGRATIONS.map((m) => m.name)).toEqual(expected);
  });
});

describe('no code enables synchronize', () => {
  it('finds no `synchronize` setting other than false under src/', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      [...readFileSync(file, 'utf8').matchAll(/synchronize\s*:\s*([^\s,}]+)/g)].some(
        ([, value]) => value !== 'false',
      ),
    );
    expect(offenders).toEqual([]);
  });
});

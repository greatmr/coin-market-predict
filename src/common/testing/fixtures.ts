import { readFileSync } from 'node:fs';

/** Saved provider responses and samples under `test/fixtures/` (synthetic or recorded; never live calls). */
export const fixtureUrl = (name: string): URL =>
  new URL(`../../../test/fixtures/${name}`, import.meta.url);

export const readFixture = (name: string): string => readFileSync(fixtureUrl(name), 'utf8');

export const readJsonFixture = <T = unknown>(name: string): T => JSON.parse(readFixture(name)) as T;

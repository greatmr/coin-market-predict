import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { DataSource } from 'typeorm';

import { resolveFileSecrets } from '../config/env.validation.js';

import { buildDataSourceOptions } from './typeorm-options.js';

/**
 * DataSource for the TypeORM CLI (`npm run migration:*`, run against the compiled
 * `dist/database/data-source.js`). The application builds its connection in `database.module.ts`
 * from the same `buildDataSourceOptions`. Constructing this object does not connect.
 */
if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const env = resolveFileSecrets(process.env);

export default new DataSource(buildDataSourceOptions((key) => env[key]));

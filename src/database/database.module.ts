import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { APP_CONFIG, type AppConfig } from '../config/index.js';

import { buildDataSourceOptions } from './typeorm-options.js';

/** The application's PostgreSQL connection (TypeORM). PostgreSQL is the source of truth. */
@Module({})
export class DatabaseModule {
  static forRoot(): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (cfg: AppConfig) => ({
            ...buildDataSourceOptions(
              (key) => cfg[key as keyof AppConfig] as string | number | boolean | undefined,
            ),
            retryAttempts: 2,
            retryDelay: 1_500,
          }),
        }),
      ],
    };
  }
}

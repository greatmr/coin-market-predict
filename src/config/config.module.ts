import { type DynamicModule, Global, Module } from '@nestjs/common';

import { APP_CONFIG } from './config.constants.js';
import type { AppConfig } from './env.validation.js';

/**
 * The configuration is validated (Zod, `env.validation.ts`) before Nest boots, so every entry point
 * fails fast with one message naming each bad variable. This global module only hands the typed
 * result to the providers that inject `APP_CONFIG`.
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: cfg }],
      exports: [APP_CONFIG],
    };
  }
}

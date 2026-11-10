import { type DynamicModule, Global, Module } from '@nestjs/common';

import { APP_CONFIG, CONFIG_INPUTS, type ConfigInputs } from './config.constants.js';
import type { AppConfig } from './env.validation.js';
import { LiveConfig } from './live-config.js';

/**
 * The configuration is validated (Zod, `env.validation.ts`) before Nest boots, so every entry point
 * fails fast with one message naming each bad variable. This global module hands the typed result
 * to the providers that inject `APP_CONFIG`, together with what it was built from (`CONFIG_INPUTS`)
 * and `LiveConfig`, which applies dashboard settings to it while the process runs.
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(cfg: AppConfig, inputs: ConfigInputs): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: CONFIG_INPUTS, useValue: inputs },
        LiveConfig,
      ],
      exports: [APP_CONFIG, CONFIG_INPUTS, LiveConfig],
    };
  }
}

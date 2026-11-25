import { Controller, Get, Inject } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/index.js';

/**
 * Liveness probe at `/healthz` (outside the `/api` prefix and the dashboard's Basic auth), used by
 * the container health check. It reports that the process serves requests and which build it runs
 * (the commit stamped into the image), so the served API can be matched to the code and the UI.
 * Nothing about data.
 */
@Controller('healthz')
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Get()
  check() {
    return {
      status: 'ok',
      service: 'coins-predicts',
      timestamp: new Date().toISOString(),
      build: { commit: this.cfg.APP_BUILD_COMMIT, builtAt: this.cfg.APP_BUILD_TIME },
    };
  }
}

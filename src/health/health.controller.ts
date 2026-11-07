import { Controller, Get } from '@nestjs/common';

/**
 * Liveness probe at `/healthz` (outside the `/api` prefix and the dashboard's Basic auth), used by
 * the container health check. It reports that the process serves requests and nothing about data.
 */
@Controller('healthz')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'coins-predicts', timestamp: new Date().toISOString() };
  }
}

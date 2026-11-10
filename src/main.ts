import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { RedactingLogger } from './common/logging/redacting.logger.js';
import { redact } from './common/security/redact.js';
import { securityHeaders } from './common/security/security-headers.middleware.js';

import { describeConfig } from './config/index.js';
import { loadConfigOrExit } from './config/load-config.js';

import { loadSavedSettings } from './modules/settings/settings.store.js';

import { AppModule } from './app.module.js';

/** Routes outside the `/api` prefix: MCP keeps its own path (and bearer auth); `/healthz` is the liveness probe. */
export const GLOBAL_PREFIX_EXCLUDES = [
  { path: 'mcp', method: RequestMethod.ALL },
  { path: 'healthz', method: RequestMethod.GET },
];

/** Fail fast with a readable message before schedulers and the bot start. */
function assertPortFree(port: number, host: string): Promise<void> {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) =>
      fail(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${port} on ${host} is already in use — another Coins Predicts instance is probably running.\nStop it with: pkill -f "dist/main.js"   (or set PORT=3001 in .env)`,
            )
          : err,
      ),
    );
    probe.listen(port, host, () => probe.close(() => ok()));
  });
}

async function main() {
  // Dashboard settings first (retried while the database starts), then one validation of both.
  const saved = await loadSavedSettings(process.env, { attempts: 10, delayMs: 3_000 });
  const cfg = loadConfigOrExit(process.env, saved);
  await assertPortFree(cfg.PORT, cfg.HOST);
  const logger = new RedactingLogger();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(cfg, { inputs: { env: process.env, forced: {} } }),
    { logger, bufferLogs: true },
  );
  app.useLogger(logger);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  // Behind a reverse proxy (nginx, Caddy): real client IPs and HTTPS detection for the session cookie.
  if (cfg.TRUST_PROXY)
    app.set(
      'trust proxy',
      /^\d+$/.test(cfg.TRUST_PROXY) ? Number(cfg.TRUST_PROXY) : cfg.TRUST_PROXY,
    );
  // Dashboard sign-in and permissions: AuthGuard (modules/auth), registered by the dashboard module.
  // JSON API: `/api/*`, every response `{ data, errors }` (see common/dto/api-response.dto.ts).
  app.setGlobalPrefix('api', { exclude: GLOBAL_PREFIX_EXCLUDES });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  // The dashboard (static, same origin) — `public/`.
  app.useStaticAssets(resolve(process.env.COINS_PUBLIC_DIR ?? 'public'), { index: 'index.html' });
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, cfg.HOST);
  const d = describeConfig(cfg);
  logger.log(
    `Coins Predicts on http://${cfg.HOST}:${cfg.PORT} — data=${d.DATA_SOURCE}${cfg.DATA_SOURCE === 'fixture' ? ' (SYNTHETIC)' : ''}, strategy=Two-Tier VMC (Tier 1 scan + human review), telegram=${d.TELEGRAM_MODE}, scheduler=${cfg.SCHEDULER_ENABLED ? 'on' : 'off'}, dashboard settings saved=${Object.keys(saved).length}`,
    'Bootstrap',
  );
}

main().catch((err) => {
  process.stderr.write(
    `\nCoins Predicts failed to start:\n${redact(err instanceof Error ? err.message : String(err))}\n`,
  );
  process.exit(1);
});

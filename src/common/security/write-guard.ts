import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import { ErrorCodes } from '../dto/error-codes.js';

export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const forbidden = (message: string) =>
  new ForbiddenException({ message, code: ErrorCodes.WRITE_FORBIDDEN });

/**
 * Guard for the few endpoints that change state. A page on another website must not be able to
 * trigger them through the operator's browser, and an unauthenticated dashboard reachable from the
 * network must not accept them at all.
 */
export function assertTrustedWrite(
  req: Pick<Request, 'is' | 'headers'>,
  cfg: { HOST: string; DASHBOARD_BASIC_AUTH?: string },
) {
  if (!cfg.DASHBOARD_BASIC_AUTH && !LOOPBACK.has(cfg.HOST)) {
    throw forbidden(
      'Changing access from the dashboard needs DASHBOARD_BASIC_AUTH when HOST is not loopback.',
    );
  }
  // application/json is not a CORS-simple type, so browsers preflight (and block) cross-site calls.
  if (!req.is('application/json')) throw forbidden('JSON requests only.');
  const origin = req.headers.origin;
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* "null" or malformed origin: refused below */
    }
    if (host !== req.headers.host) throw forbidden('Cross-origin request refused.');
  }
}

/** Whether the dashboard may write at all with this configuration (shown to the UI). */
export const canWrite = (cfg: { HOST: string; DASHBOARD_BASIC_AUTH?: string }) =>
  !!cfg.DASHBOARD_BASIC_AUTH || LOOPBACK.has(cfg.HOST);

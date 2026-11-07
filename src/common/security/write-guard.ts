import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import { ErrorCodes } from '../dto/error-codes.js';

const forbidden = (message: string) =>
  new ForbiddenException({ message, code: ErrorCodes.WRITE_FORBIDDEN });

/**
 * Every state-changing dashboard request (checked by the auth guard): a page on another website
 * must not be able to trigger it through a signed-in browser. JSON is not a CORS-simple type, so
 * browsers preflight (and block) cross-site calls; the Origin and Fetch Metadata headers, when
 * present, must name this same site. The session cookie is also SameSite=Strict.
 */
export function assertTrustedWrite(req: Pick<Request, 'is' | 'headers'>) {
  if (!req.is('application/json')) throw forbidden('JSON requests only.');
  if (req.headers['sec-fetch-site'] === 'cross-site')
    throw forbidden('Cross-site request refused.');
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

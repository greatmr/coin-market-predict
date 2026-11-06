import type { NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

/** Paths that never need dashboard credentials: MCP has its own bearer tokens; /healthz is liveness only. */
const OPEN_PATHS = ['/mcp', '/healthz'];

/** Optional HTTP Basic auth for the dashboard and its API (MCP uses its own bearer tokens). */
export function basicAuth(credentials: string | undefined) {
  const expected = credentials ? createHash('sha256').update(credentials).digest() : null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected || OPEN_PATHS.some((p) => req.path === p || req.path.startsWith(`${p}/`)))
      return next();
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const given = m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
    if (given && timingSafeEqual(createHash('sha256').update(given).digest(), expected))
      return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="coins-predicts"');
    res.status(401).send('authentication required');
  };
}

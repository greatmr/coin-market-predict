import { ForbiddenException } from "@nestjs/common";
import type { Request } from "express";

export const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Guard for the few endpoints that change state. A page on another website must not be able to
 * trigger them through the operator's browser, and an unauthenticated dashboard reachable from the
 * network must not accept them at all.
 */
export function assertTrustedWrite(req: Pick<Request, "is" | "headers">, cfg: { HOST: string; DASHBOARD_BASIC_AUTH?: string }) {
  if (!cfg.DASHBOARD_BASIC_AUTH && !LOOPBACK.has(cfg.HOST)) {
    throw new ForbiddenException("Changing access from the dashboard needs DASHBOARD_BASIC_AUTH when HOST is not loopback.");
  }
  // application/json is not a CORS-simple type, so browsers preflight (and block) cross-site calls.
  if (!req.is("application/json")) throw new ForbiddenException("JSON requests only.");
  const origin = req.headers.origin;
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch { /* "null" or malformed origin: refused below */ }
    if (host !== req.headers.host) throw new ForbiddenException("Cross-origin request refused.");
  }
}

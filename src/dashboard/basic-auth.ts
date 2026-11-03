import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Optional HTTP Basic auth for the dashboard and its API (MCP uses its own bearer tokens). */
export function basicAuth(credentials: string | undefined) {
  const expected = credentials ? createHash("sha256").update(credentials).digest() : null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected || req.path.startsWith("/mcp")) return next();
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
    const given = m ? Buffer.from(m[1]!, "base64").toString("utf8") : "";
    if (given && timingSafeEqual(createHash("sha256").update(given).digest(), expected)) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="coins-predicts"');
    res.status(401).send("authentication required");
  };
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
}

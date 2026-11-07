import type { NextFunction, Request, Response } from 'express';

/** Strict headers for the dashboard (self-hosted scripts and styles, CMC logos only as images). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https://s2.coinmarketcap.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

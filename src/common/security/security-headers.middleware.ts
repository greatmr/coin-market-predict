import type { NextFunction, Request, Response } from 'express';

/**
 * Headers for every API response (JSON and export files). The API serves no pages, so its CSP
 * allows nothing; the dashboard's own CSP is sent by the web container with the HTML
 * (front/nginx/default.conf.template).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

import type { NextFunction, Request, Response } from 'express';

/** TradingView's widget host: the live chart is a sandboxed, cross-origin iframe (no third-party script runs in the dashboard). */
export const TRADINGVIEW_WIDGET_ORIGIN = 'https://www.tradingview-widget.com';

/** Strict headers for the dashboard (self-hosted scripts and styles, CMC logos only as images). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; img-src 'self' data: https://s2.coinmarketcap.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src ${TRADINGVIEW_WIDGET_ORIGIN}; frame-ancestors 'none'`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

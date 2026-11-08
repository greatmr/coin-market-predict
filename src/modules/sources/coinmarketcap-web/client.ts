import { parseExactJson, sha256 } from '../../../common/utils/decimal.js';

import { PoliteHttpClient, SourceUnavailableError } from '../http/polite-client.js';
import type { ProviderInfo } from '../source.types.js';

import { CmcApiError } from './errors.js';

export const CMC_WEB_PROVIDER: ProviderInfo = {
  id: 'coinmarketcap_web',
  name: 'CoinMarketCap website',
  accessMethod: 'website',
  isLive: true,
  baseUrl: 'https://api.coinmarketcap.com',
  termsUrl: 'https://coinmarketcap.com/terms/',
  attribution: 'Data: CoinMarketCap',
};
/** Full listing: every listed coin with rank, tags, date added and the USD quote. */
export const WEB_LISTING = '/data-api/v3/cryptocurrency/listing';
/** Completed daily OHLCV with market cap (the Historical Data table). */
export const WEB_HISTORY = '/data-api/v3.1/cryptocurrency/historical';
/** One exchange's market pairs (used for LBank Spot pairs). */
export const WEB_EXCHANGE_PAIRS = '/data-api/v3/exchange/market-pairs/latest';
/** One coin's market pairs (the coin page Markets table). */
export const WEB_COIN_PAIRS = '/data-api/v3/cryptocurrency/market-pairs/latest';
const ROUTES = new Set([WEB_LISTING, WEB_HISTORY, WEB_EXCHANGE_PAIRS, WEB_COIN_PAIRS]);

export interface CmcWebResponse {
  body: unknown;
  endpoint: string;
  params: Record<string, string>;
  retrievedAt: Date;
  /** SHA-256 of the exact response text (provenance without storing every body). */
  sha256: string;
}

export interface CmcStatus {
  errorCode: number;
  errorMessage: string | null;
}

export function parseStatus(body: unknown): CmcStatus | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const s = (body as { status?: unknown }).status;
  if (!s || typeof s !== 'object') return null;
  const st = s as Record<string, unknown>;
  const code = Number(st.error_code ?? 0);
  return {
    errorCode: Number.isFinite(code) ? code : -1,
    errorMessage: typeof st.error_message === 'string' ? st.error_message : null,
  };
}

/** CMC's website can return error_code != 0 with HTTP 200. Never ingest that as success. */
export function webResponseStatus(res: Response, text: string): number {
  if (!res.ok) return res.status;
  if (text.trimStart().startsWith('<'))
    return /captcha|cf-chl-|just a moment|access denied/i.test(text) ? 403 : 422;
  try {
    const s = parseStatus(parseExactJson(text));
    if (!s) return 422;
    if (s.errorCode === 0) return res.status;
    if ([401, 403, 429].includes(s.errorCode)) return s.errorCode;
    if (/rate.?limit|too many/i.test(s.errorMessage ?? '')) return 429;
    if (/unexpected value|param|invalid/i.test(s.errorMessage ?? '')) return 400;
    return s.errorCode >= 500 ? 503 : 400;
  } catch {
    return 422;
  }
}

/** One shared HTTP queue for all website consumers in this application. */
export class CmcWebClient {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, { text: string; at: Date }>();

  constructor(
    readonly http: PoliteHttpClient,
    private readonly cacheMs = 60_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get requestsMade() {
    return this.http.requestsMade;
  }

  get(endpoint: string, rawParams: Record<string, string | number> = {}): Promise<CmcWebResponse> {
    const run = this.queue.then(() => this.request(endpoint, rawParams));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(
    endpoint: string,
    rawParams: Record<string, string | number>,
  ): Promise<CmcWebResponse> {
    if (!ROUTES.has(endpoint)) throw new Error('Unsupported CMC website endpoint');
    const params = Object.fromEntries(Object.entries(rawParams).map(([k, v]) => [k, String(v)]));
    const query = new URLSearchParams(params).toString();
    const url = `${CMC_WEB_PROVIDER.baseUrl}${endpoint}${query ? `?${query}` : ''}`;
    const cached = this.cache.get(url);
    let text: string;
    let retrievedAt = this.now();
    if (cached && this.now().getTime() - cached.at.getTime() < this.cacheMs) {
      text = cached.text;
      retrievedAt = cached.at;
    } else {
      try {
        text = await this.http.getText(url, async () => {
          retrievedAt = this.now();
        });
      } catch (err) {
        if (err instanceof SourceUnavailableError) {
          const kind = ['denied', 'suspended'].includes(err.reason)
            ? 'auth'
            : err.reason === 'budget_exhausted'
              ? 'budget'
              : ['retry_after', 'circuit_open'].includes(err.reason) || err.httpStatus === 429
                ? 'rate_limited'
                : err.httpStatus === 422
                  ? 'invalid_response'
                  : err.httpStatus && err.httpStatus < 500
                    ? 'bad_request'
                    : err.httpStatus
                      ? 'server'
                      : 'network';
          throw new CmcApiError(kind, err.message, err.httpStatus, null, { cause: err });
        }
        throw err;
      }
      for (const [k, v] of this.cache)
        if (retrievedAt.getTime() - v.at.getTime() >= this.cacheMs) this.cache.delete(k);
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      if (this.cacheMs > 0) this.cache.set(url, { text, at: retrievedAt });
    }
    let body: unknown;
    try {
      body = parseExactJson(text);
    } catch {
      throw new CmcApiError('invalid_response', 'CMC website: response is not JSON', null, null);
    }
    return { body, endpoint, params, retrievedAt, sha256: sha256(text) };
  }
}

import { SourceUnavailableError } from '../http/polite-client.js';

export type CmcErrorKind =
  'auth' | 'rate_limited' | 'budget' | 'invalid_response' | 'bad_request' | 'server' | 'network';

/** A CMC website request or response that cannot be used. */
export class CmcApiError extends Error {
  constructor(
    public readonly kind: CmcErrorKind,
    message: string,
    public readonly httpStatus: number | null,
    public readonly errorCode: number | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CmcApiError';
  }
}

/** Run-wide conditions: stop the stage instead of repeating the request for every asset. */
export function stopsCrawl(err: unknown): boolean {
  if (err instanceof SourceUnavailableError) return true;
  if (err instanceof CmcApiError) return ['auth', 'rate_limited', 'budget'].includes(err.kind);
  return true;
}

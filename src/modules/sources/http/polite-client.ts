import { redact } from '../../../common/security/redact.js';
import { type Clock, sleep as realSleep, systemClock } from '../../../common/utils/time.js';

import type { SourceHealthState, SourceHealthStore } from './source-health.js';

export interface PoliteClientOptions {
  providerId: string;
  requestsPerMinute: number;
  /** Hard cap on requests per calendar month (UTC). */
  monthlyBudget: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Longest Retry-After we are willing to wait inline; longer values abort the run. */
  maxInlineRetryAfterMs?: number;
  failureThreshold?: number;
  openCooldownMs?: number;
  /** Consecutive 401/403 responses after which collection is suspended until manual reset. */
  denialThreshold?: number;
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  store: SourceHealthStore;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Interpret providers that report application errors inside an HTTP 200 response. */
  responseStatus?: (response: Response, body: string) => number;
}

/** How long an open circuit refuses requests before it allows one trial request. */
export const DEFAULT_OPEN_COOLDOWN_MS = 15 * 60_000;

export class SourceUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'circuit_open' | 'suspended' | 'budget_exhausted' | 'retry_after' | 'denied' | 'failed',
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

interface CacheEntry {
  etag: string;
  body: string;
}

/**
 * HTTP client for permitted, documented endpoints only. It enforces a request budget,
 * sequential requests with a per-minute rate limit, exponential backoff with jitter,
 * Retry-After handling, conditional requests (ETag), and a persisted circuit breaker that
 * suspends collection on persistent access denial. It never rotates identities or proxies.
 */
export class PoliteHttpClient {
  private readonly o: Required<
    Omit<PoliteClientOptions, 'headers' | 'fetchImpl' | 'clock' | 'sleep' | 'responseStatus'>
  > & {
    headers: Record<string, string>;
    responseStatus?: PoliteClientOptions['responseStatus'];
  };
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly etagCache = new Map<string, CacheEntry>();
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  public requestsMade = 0;

  constructor(opts: PoliteClientOptions) {
    this.o = {
      maxAttempts: 4,
      baseBackoffMs: 2_000,
      maxBackoffMs: 60_000,
      maxInlineRetryAfterMs: 120_000,
      failureThreshold: 5,
      openCooldownMs: DEFAULT_OPEN_COOLDOWN_MS,
      denialThreshold: 2,
      timeoutMs: 30_000,
      userAgent: 'CoinsPredicts/0.1 (research; low-frequency)',
      headers: {},
      ...opts,
    } as PoliteHttpClient['o'];
    this.clock = opts.clock ?? systemClock;
    this.sleep = opts.sleep ?? realSleep;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** New rate limit, monthly budget or attempt count (dashboard settings), from the next request. */
  setLimits(
    limits: Partial<
      Pick<PoliteClientOptions, 'requestsPerMinute' | 'monthlyBudget' | 'maxAttempts'>
    >,
  ) {
    for (const [key, value] of Object.entries(limits))
      if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        this.o[key as 'requestsPerMinute' | 'monthlyBudget' | 'maxAttempts'] = value;
  }

  /** Serialized GET returning parsed JSON. Concurrency is always 1 per client. */
  async getJson<T>(url: string): Promise<T> {
    return JSON.parse(await this.getText(url)) as T;
  }

  /** Keep the original digits for Decimal parsing and raw-response auditing. */
  getText(
    url: string,
    onResponse?: (res: Response, body: string) => Promise<void>,
  ): Promise<string> {
    const run = this.queue.then(() => this.doGet(url, onResponse));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doGet(
    url: string,
    onResponse?: (res: Response, body: string) => Promise<void>,
  ): Promise<string> {
    let attempt = 0;
    for (;;) {
      attempt++;
      const health = await this.o.store.load(this.o.providerId);
      this.assertAvailable(health);
      this.consumeBudget(health);
      await this.o.store.save(this.o.providerId, health);
      await this.rateLimit();

      let res: Response;
      let body: string;
      try {
        const headers: Record<string, string> = {
          accept: 'application/json',
          'user-agent': this.o.userAgent,
          ...this.o.headers,
        };
        const cached = this.etagCache.get(url);
        if (cached) headers['if-none-match'] = cached.etag;
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.o.timeoutMs) });
        this.requestsMade++;
        body = await res.text();
      } catch (err) {
        await this.recordFailure(null);
        if (attempt >= this.o.maxAttempts) {
          throw new SourceUnavailableError(
            `Request failed after ${attempt} attempts: ${redact(err)}`,
            'failed',
          );
        }
        await this.sleep(this.backoff(attempt));
        continue;
      }

      await onResponse?.(res, res.status === 304 ? (this.etagCache.get(url)?.body ?? body) : body);
      const status = this.o.responseStatus?.(res, body) ?? res.status;

      if (status === 304) {
        const cached = this.etagCache.get(url);
        await this.recordSuccess(304);
        if (cached) return cached.body;
      }

      if (status >= 200 && status < 300) {
        const etag = res.headers.get('etag');
        if (etag) {
          if (this.etagCache.size >= 64) this.etagCache.delete(this.etagCache.keys().next().value!);
          this.etagCache.set(url, { etag, body });
        }
        await this.recordSuccess(res.status);
        return body;
      }

      if (status === 401 || status === 403) {
        const h = await this.recordDenial(status);
        throw new SourceUnavailableError(
          `Access denied (HTTP ${status}). ${h.state === 'suspended' ? 'Collection suspended until manual reset.' : 'Will retry next run.'}`,
          'denied',
          status,
        );
      }

      const retryable = status === 429 || status >= 500;
      await this.recordFailure(status);
      if (!retryable) {
        throw new SourceUnavailableError(
          `HTTP ${status} for ${redact(stripQuery(url))}`,
          'failed',
          status,
        );
      }
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.clock.now());
      if (status === 429) {
        const h = await this.o.store.load(this.o.providerId);
        h.retryAfterUntil = new Date(this.clock.now().getTime() + (retryAfterMs ?? 60_000));
        await this.o.store.save(this.o.providerId, h);
      }
      if (retryAfterMs !== null && retryAfterMs > this.o.maxInlineRetryAfterMs) {
        const h = await this.o.store.load(this.o.providerId);
        h.retryAfterUntil = new Date(this.clock.now().getTime() + retryAfterMs);
        await this.o.store.save(this.o.providerId, h);
        throw new SourceUnavailableError(
          `Source asked us to wait ${Math.round(retryAfterMs / 1000)}s`,
          'retry_after',
          status,
        );
      }
      if (attempt >= this.o.maxAttempts) {
        throw new SourceUnavailableError(
          `HTTP ${status} after ${attempt} attempts`,
          'failed',
          status,
        );
      }
      await this.sleep(
        Math.max(retryAfterMs ?? (status === 429 ? 60_000 : 0), this.backoff(attempt)),
      );
    }
  }

  private assertAvailable(h: SourceHealthState): void {
    const now = this.clock.now();
    if (h.state === 'suspended') {
      throw new SourceUnavailableError(
        `Source suspended: ${h.suspendedReason ?? 'persistent access denial'}`,
        'suspended',
      );
    }
    if (h.retryAfterUntil && h.retryAfterUntil > now) {
      throw new SourceUnavailableError(
        `Honoring Retry-After until ${h.retryAfterUntil.toISOString()}`,
        'retry_after',
      );
    }
    if (h.state === 'open') {
      if (h.openedAt && now.getTime() - h.openedAt.getTime() >= this.o.openCooldownMs) {
        h.state = 'half_open';
      } else {
        const reopensAt = h.openedAt
          ? new Date(h.openedAt.getTime() + this.o.openCooldownMs).toISOString()
          : 'unknown';
        throw new SourceUnavailableError(
          `Circuit breaker open after ${h.consecutiveFailures} consecutive failures ` +
            `(last: ${h.lastStatusCode === null ? 'network error/timeout' : `HTTP ${h.lastStatusCode}`}); ` +
            `next attempt allowed after ${reopensAt}`,
          'circuit_open',
        );
      }
    }
  }

  private consumeBudget(h: SourceHealthState): void {
    const now = this.clock.now();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if (!h.budgetPeriodStart || h.budgetPeriodStart.getTime() !== periodStart.getTime()) {
      h.budgetPeriodStart = periodStart;
      h.budgetUsed = 0;
    }
    if (h.budgetUsed >= this.o.monthlyBudget) {
      throw new SourceUnavailableError(
        `Monthly request budget exhausted (${h.budgetUsed}/${this.o.monthlyBudget})`,
        'budget_exhausted',
      );
    }
    h.budgetUsed++;
  }

  private async rateLimit(): Promise<void> {
    const minInterval = 60_000 / this.o.requestsPerMinute;
    const now = this.clock.now().getTime();
    const wait = this.lastRequestAt + minInterval - now;
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Math.max(now, this.lastRequestAt + minInterval);
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.o.maxBackoffMs, this.o.baseBackoffMs * 2 ** (attempt - 1));
    // Retry jitter only spreads load; it protects nothing, so a non-cryptographic random is fine.
    // eslint-disable-next-line no-restricted-properties
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  private async recordSuccess(status: number) {
    const h = await this.o.store.load(this.o.providerId);
    h.state = 'closed';
    h.consecutiveFailures = 0;
    h.consecutiveDenials = 0;
    h.openedAt = null;
    h.lastSuccessAt = this.clock.now();
    h.lastStatusCode = status;
    await this.o.store.save(this.o.providerId, h);
  }

  private async recordFailure(status: number | null) {
    const h = await this.o.store.load(this.o.providerId);
    h.consecutiveFailures++;
    h.lastFailureAt = this.clock.now();
    h.lastStatusCode = status;
    if (h.state === 'half_open' || h.consecutiveFailures >= this.o.failureThreshold) {
      h.state = 'open';
      h.openedAt = this.clock.now();
    }
    await this.o.store.save(this.o.providerId, h);
  }

  private async recordDenial(status: number) {
    const h = await this.o.store.load(this.o.providerId);
    h.consecutiveDenials++;
    h.lastFailureAt = this.clock.now();
    h.lastStatusCode = status;
    if (h.consecutiveDenials >= this.o.denialThreshold) {
      h.state = 'suspended';
      h.suspendedReason = `HTTP ${status} returned ${h.consecutiveDenials} times in a row`;
    }
    await this.o.store.save(this.o.providerId, h);
    return h;
  }
}

/** Parse Retry-After (delta-seconds or HTTP-date). Returns milliseconds or null. */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now.getTime());
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

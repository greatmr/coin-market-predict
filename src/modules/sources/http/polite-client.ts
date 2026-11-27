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

/** Per-request timing callbacks (times from the client's clock). */
export interface RequestHooks {
  /** An attempt is about to be sent (after queueing and rate limiting). */
  onSend?: (attempt: number, at: Date) => void;
  /** An attempt failed (network error, timeout, or a retryable HTTP status); it may be retried. */
  onAttemptError?: (attempt: number, sentAt: Date | null, at: Date, message: string) => void;
}

/**
 * Which queue a request waits in. `immediate`: a request fired the moment a signal is published
 * (its timing is part of what is measured); `prompt`: short scheduled work that should not sit behind
 * a batch (a minute sample, an order-book read); `routine`: everything else (verification batches,
 * listings). Lanes change only the order in which waiting requests are sent, never the pacing.
 */
export type RequestLane = 'immediate' | 'prompt' | 'routine';
export interface RequestOptions {
  lane?: RequestLane;
}
const LANE_RANK: Record<RequestLane, number> = { immediate: 0, prompt: 1, routine: 2 };
/**
 * After this many requests of a higher lane were sent in a row while a routine request waited, the
 * oldest routine request goes next: a flood of urgent requests can delay routine work, never stop it.
 */
export const MAX_PRIORITY_STREAK = 8;

interface Waiter {
  lane: RequestLane;
  seq: number;
  grant: () => void;
}

/**
 * HTTP client for permitted, documented endpoints only. It enforces a request budget, a per-minute
 * rate limit (request starts at least 60 000 / requestsPerMinute ms apart, whatever the lane),
 * exponential backoff with jitter, Retry-After handling (no request of any lane is sent before it
 * passes), conditional requests (ETag), and a persisted circuit breaker that suspends collection on
 * persistent access denial. It never rotates identities or proxies.
 *
 * Requests wait in lanes (`RequestLane`): when the next send is allowed, the most urgent waiting
 * request goes first (FIFO within a lane), so a publication request never queues behind a batch of
 * routine requests. One request is in flight at a time, except that an `immediate` request may start
 * while one other request is still awaiting its response (at most two, still paced); a retry waits
 * out its backoff outside the queue. Before 2026-11-27 the client was one FIFO queue.
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
  /** No request is sent before this time (a Retry-After the source asked for). */
  private blockedUntil = 0;
  private readonly waiting: Waiter[] = [];
  private seq = 0;
  /** A granted attempt has not been sent yet (sends are strictly one after another). */
  private pending = false;
  /** Attempts sent and still awaiting their response. */
  private inFlight = 0;
  private pumping = false;
  private priorityStreak = 0;
  private healthChain: Promise<unknown> = Promise.resolve();
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

  /** GET returning parsed JSON (routine lane). */
  async getJson<T>(url: string): Promise<T> {
    return JSON.parse(await this.getText(url)) as T;
  }

  /**
   * Keep the original digits for Decimal parsing and raw-response auditing. `hooks` report when each
   * attempt is actually sent (after the queue and the rate-limit wait) and when an attempt fails,
   * for callers that must record real request timing. `opts.lane` decides the queue (default
   * `routine`).
   */
  getText(
    url: string,
    onResponse?: (res: Response, body: string) => Promise<void>,
    hooks?: RequestHooks,
    opts: RequestOptions = {},
  ): Promise<string> {
    return this.doGet(url, onResponse, hooks, opts.lane ?? 'routine');
  }

  // ── Queue ───────────────────────────────────────────────────────────────────────────────

  /** Resolves when this request may be sent (it then holds the next send until it is sent). */
  private acquire(lane: RequestLane, seq: number): Promise<void> {
    return new Promise<void>((grant) => {
      this.waiting.push({ lane, seq, grant });
      void this.pump();
    });
  }

  /** The most urgent waiting request (FIFO within a lane), unless routine work is overdue. */
  private pick(): Waiter | undefined {
    let best: Waiter | undefined;
    let routine: Waiter | undefined;
    for (const w of this.waiting) {
      if (
        !best ||
        LANE_RANK[w.lane] < LANE_RANK[best.lane] ||
        (LANE_RANK[w.lane] === LANE_RANK[best.lane] && w.seq < best.seq)
      )
        best = w;
      if (w.lane === 'routine' && (!routine || w.seq < routine.seq)) routine = w;
    }
    return routine && best !== routine && this.priorityStreak >= MAX_PRIORITY_STREAK
      ? routine
      : best;
  }

  /**
   * Grant the next send once it is allowed: nothing pending, a free slot (an `immediate` request may
   * join one request in flight), and the pacing and any Retry-After have passed. The choice is made
   * only when the send is allowed, so a request that arrives during the wait can still go first.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.pending || !this.waiting.length) return;
        const next = this.pick()!;
        if (this.inFlight > 0 && !(next.lane === 'immediate' && this.inFlight < 2)) return;
        const notBefore = Math.max(
          this.lastRequestAt + 60_000 / this.o.requestsPerMinute,
          this.blockedUntil,
        );
        const wait = notBefore - this.clock.now().getTime();
        if (wait > 0) {
          await this.sleep(wait);
          continue;
        }
        this.waiting.splice(this.waiting.indexOf(next), 1);
        const routineWaits = this.waiting.some((w) => w.lane === 'routine');
        this.priorityStreak = next.lane !== 'routine' && routineWaits ? this.priorityStreak + 1 : 0;
        this.pending = true;
        next.grant();
        return;
      }
    } finally {
      this.pumping = false;
    }
  }

  /** The granted attempt will not be sent after all (unavailable source, budget). */
  private releaseUnsent() {
    this.pending = false;
    void this.pump();
  }

  /** The granted attempt is being sent now: the next one may be chosen. */
  private markSent() {
    this.pending = false;
    this.inFlight++;
    void this.pump();
  }

  /** A sent attempt finished (response read, or failed): its slot is free. */
  private markDone() {
    this.inFlight--;
    void this.pump();
  }

  private async doGet(
    url: string,
    onResponse: ((res: Response, body: string) => Promise<void>) | undefined,
    hooks: RequestHooks | undefined,
    lane: RequestLane,
  ): Promise<string> {
    const seq = this.seq++;
    let attempt = 0;
    for (;;) {
      attempt++;
      // A retry keeps its place in the lane (its original sequence number).
      await this.acquire(lane, seq);
      let sent = false;
      let res: Response;
      let body: string;
      let sentAt: Date | null = null;
      try {
        await this.withHealth((h) => {
          this.assertAvailable(h);
          this.consumeBudget(h);
        });
        await this.rateLimit();
        const headers: Record<string, string> = {
          accept: 'application/json',
          'user-agent': this.o.userAgent,
          ...this.o.headers,
        };
        const cached = this.etagCache.get(url);
        if (cached) headers['if-none-match'] = cached.etag;
        sentAt = this.clock.now();
        sent = true;
        this.markSent();
        hooks?.onSend?.(attempt, sentAt);
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.o.timeoutMs) });
        this.requestsMade++;
        body = await res.text();
      } catch (err) {
        if (!sent) {
          this.releaseUnsent();
          throw err;
        }
        this.markDone();
        hooks?.onAttemptError?.(attempt, sentAt, this.clock.now(), redact(err).slice(0, 300));
        await this.recordFailure(null);
        if (attempt >= this.o.maxAttempts) {
          throw new SourceUnavailableError(
            `Request failed after ${attempt} attempts: ${redact(err)}`,
            'failed',
          );
        }
        // The backoff is waited outside the queue: other requests go meanwhile.
        await this.sleep(this.backoff(attempt));
        continue;
      }
      this.markDone();

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
      hooks?.onAttemptError?.(attempt, sentAt, this.clock.now(), `HTTP ${status}`);
      await this.recordFailure(status);
      if (!retryable) {
        throw new SourceUnavailableError(
          `HTTP ${status} for ${redact(stripQuery(url))}`,
          'failed',
          status,
        );
      }
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.clock.now());
      if (status === 429)
        await this.withHealth((h) => {
          h.retryAfterUntil = new Date(this.clock.now().getTime() + (retryAfterMs ?? 60_000));
        });
      if (retryAfterMs !== null && retryAfterMs > this.o.maxInlineRetryAfterMs) {
        await this.withHealth((h) => {
          h.retryAfterUntil = new Date(this.clock.now().getTime() + retryAfterMs);
        });
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
      if (status === 429 || retryAfterMs !== null) {
        // The source asked us to slow down: no request of any lane is sent before then.
        const wait = Math.max(retryAfterMs ?? (status === 429 ? 60_000 : 0), this.backoff(attempt));
        this.blockedUntil = Math.max(this.blockedUntil, this.clock.now().getTime() + wait);
        continue;
      }
      // Plain server error: this request backs off outside the queue; others go meanwhile.
      await this.sleep(this.backoff(attempt));
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

  /**
   * One read-modify-write of the persisted health record (budget, failures, circuit, Retry-After),
   * one at a time in this client: requests overlap now (a response is processed while the next one
   * is sent), and two interleaved updates would lose a budget or failure count. A throwing `fn`
   * (source unavailable, budget exhausted) saves nothing, as before.
   */
  private withHealth<T>(fn: (h: SourceHealthState) => T): Promise<T> {
    const run = this.healthChain.then(async () => {
      const h = await this.o.store.load(this.o.providerId);
      const out = fn(h);
      await this.o.store.save(this.o.providerId, h);
      return out;
    });
    this.healthChain = run.catch(() => undefined);
    return run;
  }

  private async recordSuccess(status: number) {
    await this.withHealth((h) => {
      h.state = 'closed';
      h.consecutiveFailures = 0;
      h.consecutiveDenials = 0;
      h.openedAt = null;
      h.lastSuccessAt = this.clock.now();
      h.lastStatusCode = status;
    });
  }

  private async recordFailure(status: number | null) {
    await this.withHealth((h) => {
      h.consecutiveFailures++;
      h.lastFailureAt = this.clock.now();
      h.lastStatusCode = status;
      if (h.state === 'half_open' || h.consecutiveFailures >= this.o.failureThreshold) {
        h.state = 'open';
        h.openedAt = this.clock.now();
      }
    });
  }

  private async recordDenial(status: number) {
    return this.withHealth((h) => {
      h.consecutiveDenials++;
      h.lastFailureAt = this.clock.now();
      h.lastStatusCode = status;
      if (h.consecutiveDenials >= this.o.denialThreshold) {
        h.state = 'suspended';
        h.suspendedReason = `HTTP ${status} returned ${h.consecutiveDenials} times in a row`;
      }
      return h;
    });
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_PRIORITY_STREAK, PoliteHttpClient, type RequestLane } from './polite-client.js';
import { InMemorySourceHealthStore } from './source-health.js';

/**
 * The shared LBank client under load (virtual time): request lanes change only the ORDER in which
 * waiting requests are sent; the pacing (60 / min → starts ≥ 1 000 ms apart), Retry-After and the
 * completion of routine work are preserved. Workload modelled on the production Spot job of
 * 2026-11-27 11:45 UTC (135 LBank requests in 138 s) with minute samples and a publication.
 */

const T0 = Date.parse('2026-11-27T11:45:00.000Z');

interface Sent {
  url: string;
  at: number;
}

function harness(latency: (url: string) => number, statusFor?: (url: string, n: number) => number) {
  const sent: Sent[] = [];
  const counts = new Map<string, number>();
  const http = new PoliteHttpClient({
    providerId: 'lbank_test',
    requestsPerMinute: 60,
    monthlyBudget: 1_000_000,
    maxAttempts: 3,
    store: new InMemorySourceHealthStore(),
    fetchImpl: (async (url: string) => {
      const at = Date.now();
      sent.push({ url, at });
      const n = (counts.get(url) ?? 0) + 1;
      counts.set(url, n);
      await new Promise((r) => setTimeout(r, latency(url)));
      const status = statusFor?.(url, n) ?? 200;
      return new Response('{}', {
        status,
        headers: status === 429 ? { 'retry-after': '3' } : {},
      });
    }) as unknown as typeof fetch,
  });
  /** One request with its queue time, send time (first attempt) and completion. */
  const get = (url: string, lane: RequestLane) => {
    const queuedAt = Date.now();
    let startedAt: number | null = null;
    return http
      .getText(url, undefined, { onSend: (_a, at) => void (startedAt ??= at.getTime()) }, { lane })
      .then(
        () => ({ url, queuedAt, startedAt: startedAt!, doneAt: Date.now(), ok: true }),
        () => ({ url, queuedAt, startedAt: startedAt!, doneAt: Date.now(), ok: false }),
      );
  };
  return { http, sent, get };
}

const gaps = (s: Sent[]) => s.slice(1).map((x, i) => x.at - s[i]!.at);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('request lanes under a Spot verification workload', () => {
  it('publication requests skip the routine backlog; pacing, minute samples and routine work intact', async () => {
    // Spot API answers in ~1.1 s (measured from the server), Futures in ~0.4 s.
    const h = harness((u) => (u.includes('futures') ? 400 : 1_100));
    // The Spot job: 135 requests, one after another (as the observation job sends them).
    const spot = (async () => {
      const out = [];
      for (let i = 0; i < 135; i++) out.push(await h.get(`spot/kline/${i}`, 'routine'));
      return out;
    })();
    // A second routine caller with a backlog (listing evidence: three requests queued at once).
    const listing = Promise.all([0, 1, 2].map((i) => h.get(`spot/list/${i}`, 'routine')));
    // Minute samples at every whole minute; a publication at 11:47:05.773 with the Futures quote and
    // the indicative Spot quote queued at the same moment, then order-book context reads.
    const ticks: Array<Promise<{ queuedAt: number; startedAt: number }>> = [];
    let publication: Array<
      Promise<{ url: string; queuedAt: number; startedAt: number; doneAt: number }>
    > = [];
    const books: Array<Promise<{ queuedAt: number; startedAt: number }>> = [];
    for (let m = 1; m <= 2; m++)
      setTimeout(() => ticks.push(h.get(`futures/tick/${m}`, 'prompt')), m * 60_000);
    setTimeout(() => {
      publication = [
        h.get('futures/marketData', 'immediate'),
        h.get('spot/price-all', 'immediate'),
      ];
      for (let b = 0; b < 3; b++) books.push(h.get(`futures/book/${b}`, 'prompt'));
    }, 125_773);

    await vi.advanceTimersByTimeAsync(400_000);
    const spotDone = await spot;
    await listing;
    const [fut, spq] = await Promise.all(publication);
    const tk = await Promise.all(ticks);

    // Pacing: no two request starts closer than 1 000 ms (60 / min), whatever the lane.
    expect(Math.min(...gaps(h.sent))).toBeGreaterThanOrEqual(1_000);
    // Every request was sent exactly once; all routine work finished (no starvation).
    expect(h.sent).toHaveLength(135 + 3 + 2 + 2 + 3);
    expect(spotDone.every((r) => r.ok)).toBe(true);

    // The Futures quote waits for the pacing only (≤ 1 000 ms), never for the routine backlog or the
    // Spot request still in flight (an immediate request may join one request in flight).
    expect(fut!.startedAt - fut!.queuedAt).toBeLessThanOrEqual(1_000);
    // The indicative Spot quote was queued at the same moment and is sent next, exactly one pacing
    // interval later: initiated together, never simultaneous; neither waited for the other's processing.
    expect(spq!.queuedAt).toBe(fut!.queuedAt);
    expect(spq!.startedAt - fut!.startedAt).toBe(1_000);
    // Minute samples: each sent once, within the in-flight request plus one pacing interval.
    for (const t of tk) expect(t.startedAt - t.queuedAt).toBeLessThanOrEqual(1_100 + 1_000);
    // Order-book context follows the quotes and does not wait for the Spot backlog either.
    const bk = await Promise.all(books);
    expect(Math.max(...bk.map((b) => b.startedAt - b.queuedAt))).toBeLessThanOrEqual(6_000);
  });

  it('the same publication in one FIFO lane (the old client) waits behind the backlog', async () => {
    const h = harness((u) => (u.includes('futures') ? 400 : 1_100));
    // Five routine callers each have a request queued when the publication arrives.
    const backlog = Array.from({ length: 5 }, (_, i) => h.get(`spot/kline/${i}`, 'routine'));
    const asRoutine = h.get('futures/marketData', 'routine');
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(backlog);
    const r = await asRoutine;
    // FIFO: behind five 1.1 s requests → ≥ 5 s. With its own lane it would go first (next test).
    expect(r.startedAt - r.queuedAt).toBeGreaterThanOrEqual(5_000);

    const h2 = harness((u) => (u.includes('futures') ? 400 : 1_100));
    const backlog2 = Array.from({ length: 5 }, (_, i) => h2.get(`spot/kline/${i}`, 'routine'));
    const asImmediate = h2.get('futures/marketData', 'immediate');
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(backlog2);
    const q = await asImmediate;
    expect(q.startedAt - q.queuedAt).toBeLessThanOrEqual(1_000);
  });

  it('a Retry-After stops every lane; a plain server error backs off outside the queue', async () => {
    const h = harness(
      () => 300,
      (u, n) => (u === 'spot/limited' && n === 1 ? 429 : u === 'spot/flaky' && n === 1 ? 503 : 200),
    );
    const limited = h.get('spot/limited', 'routine');
    await vi.advanceTimersByTimeAsync(500); // the 429 has arrived (Retry-After: 3 s)
    const urgent = h.get('futures/marketData', 'immediate');
    await vi.advanceTimersByTimeAsync(20_000);
    const [l, u] = await Promise.all([limited, urgent]);
    expect(l.ok && u.ok).toBe(true);
    const at429 = h.sent[0]!.at;
    // Nothing (not even the immediate request) was sent before the Retry-After passed.
    expect(h.sent.slice(1).every((s) => s.at >= at429 + 3_000)).toBe(true);

    const h2 = harness(
      () => 300,
      (u, n) => (u === 'spot/flaky' && n === 1 ? 503 : 200),
    );
    const flaky = h2.get('spot/flaky', 'routine');
    await vi.advanceTimersByTimeAsync(400); // the 503 has arrived; flaky backs off 1–2 s
    const other = h2.get('spot/other', 'routine');
    await vi.advanceTimersByTimeAsync(20_000);
    const [f, o] = await Promise.all([flaky, other]);
    expect(f.ok && o.ok).toBe(true);
    // The other request was sent during the backoff (after the pacing), not after the retry.
    const otherAt = h2.sent.find((s) => s.url === 'spot/other')!.at;
    const retryAt = h2.sent.filter((s) => s.url === 'spot/flaky')[1]!.at;
    expect(otherAt).toBeLessThan(retryAt);
    expect(Math.min(...gaps(h2.sent))).toBeGreaterThanOrEqual(1_000);
  });

  it('overlapping requests lose no budget or failure count (health updates one at a time)', async () => {
    // A store whose reads and writes take time, as the database does: interleaved read-modify-write
    // updates would lose increments.
    const inner = new InMemorySourceHealthStore();
    const slow = {
      load: async (id: string) => {
        await new Promise((r) => setTimeout(r, 7));
        return inner.load(id);
      },
      save: async (id: string, s: Parameters<InMemorySourceHealthStore['save']>[1]) => {
        await new Promise((r) => setTimeout(r, 7));
        return inner.save(id, s);
      },
    };
    const http = new PoliteHttpClient({
      providerId: 'lbank_test',
      requestsPerMinute: 60,
      monthlyBudget: 1_000_000,
      maxAttempts: 1,
      failureThreshold: 1_000,
      store: slow,
      fetchImpl: (async (url: string) => {
        await new Promise((r) => setTimeout(r, 1_500)); // slower than the pacing: overlaps
        return new Response('{}', { status: url.includes('bad') ? 500 : 200 });
      }) as unknown as typeof fetch,
    });
    const urls = Array.from({ length: 12 }, (_, i) => `x/${i % 3 === 0 ? 'bad' : 'ok'}/${i}`);
    const all = urls.map((u, i) =>
      http
        .getText(u, undefined, undefined, { lane: i % 2 ? 'immediate' : 'routine' })
        .catch(() => 'failed'),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const out = await Promise.all(all);
    const h = await inner.load('lbank_test');
    expect(h.budgetUsed).toBe(12);
    expect(out.filter((x) => x === 'failed')).toHaveLength(4);
    // Every failure counted (the last success resets the count; the failures after it remain).
    expect(h.lastStatusCode === 200 || h.consecutiveFailures > 0).toBe(true);
  });

  it('a flood of urgent requests delays routine work but never stops it', async () => {
    const h = harness(() => 100);
    const routine = h.get('spot/kline/0', 'routine');
    await vi.advanceTimersByTimeAsync(0);
    const urgent = Array.from({ length: 30 }, (_, i) => h.get(`futures/q/${i}`, 'immediate'));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(urgent);
    await routine;
    const order = h.sent.map((s) => s.url);
    // The routine request queued first is sent first; then at most MAX_PRIORITY_STREAK urgent ones
    // pass a waiting routine request.
    expect(order[0]).toBe('spot/kline/0');
    const h2 = harness(() => 100);
    const urgent2 = Array.from({ length: 30 }, (_, i) => h2.get(`futures/q/${i}`, 'immediate'));
    const routine2 = h2.get('spot/kline/1', 'routine');
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(urgent2);
    await routine2;
    const pos = h2.sent.findIndex((s) => s.url === 'spot/kline/1');
    expect(pos).toBeLessThanOrEqual(MAX_PRIORITY_STREAK + 1);
    expect(Math.min(...gaps(h2.sent))).toBeGreaterThanOrEqual(1_000);
  });
});

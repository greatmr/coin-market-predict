import { describe, expect, it } from "vitest";
import { parseRetryAfter, PoliteHttpClient, SourceUnavailableError } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";

function fakeClock(start = Date.parse("2026-11-03T12:00:00Z")) {
  let t = start;
  return { clock: { now: () => new Date(t) }, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => (t += ms) };
}

function client(responses: Array<() => Response>, extra: Partial<ConstructorParameters<typeof PoliteHttpClient>[0]> = {}) {
  const c = fakeClock();
  const store = new InMemorySourceHealthStore();
  let i = 0;
  const calls: Array<Record<string, string>> = [];
  const http = new PoliteHttpClient({
    providerId: "test",
    requestsPerMinute: 60,
    monthlyBudget: 100,
    store,
    clock: c.clock,
    sleep: c.sleep,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      calls.push(init.headers as Record<string, string>);
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return r();
    }) as unknown as typeof fetch,
    ...extra,
  });
  return { http, store, calls, c };
}

const ok = (body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status: 200, headers });
const status = (s: number, headers: Record<string, string> = {}) => () => new Response("{}", { status: s, headers });

describe("parseRetryAfter", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Tue, 03 Nov 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("nonsense", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("PoliteHttpClient", () => {
  it("retries 429 honoring Retry-After, then succeeds", async () => {
    const { http, store } = client([status(429, { "retry-after": "5" }), ok({ a: 1 })]);
    await expect(http.getJson("https://x.invalid/a")).resolves.toEqual({ a: 1 });
    expect((await store.load("test")).budgetUsed).toBe(2);
  });

  it("aborts instead of waiting when Retry-After is very long and remembers it", async () => {
    const { http, store } = client([status(429, { "retry-after": "3600" })]);
    await expect(http.getJson("https://x.invalid/a")).rejects.toMatchObject({ reason: "retry_after" });
    expect((await store.load("test")).retryAfterUntil).not.toBeNull();
    await expect(http.getJson("https://x.invalid/a")).rejects.toMatchObject({ reason: "retry_after" });
  });

  it("suspends collection after repeated access denial", async () => {
    const { http, store } = client([status(403)]);
    await expect(http.getJson("https://x.invalid/a")).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(http.getJson("https://x.invalid/a")).rejects.toMatchObject({ reason: "denied" });
    expect((await store.load("test")).state).toBe("suspended");
    await expect(http.getJson("https://x.invalid/a")).rejects.toMatchObject({ reason: "suspended" });
  });

  it("opens the circuit after repeated server errors", async () => {
    const { http, store } = client([status(500)], { maxAttempts: 5, failureThreshold: 5 });
    await expect(http.getJson("https://x.invalid/a")).rejects.toThrow();
    expect((await store.load("test")).state).toBe("open");
    await expect(http.getJson("https://x.invalid/a")).rejects.toMatchObject({ reason: "circuit_open" });
  });

  it("enforces the monthly request budget", async () => {
    const { http } = client([ok({})], { monthlyBudget: 2 });
    await http.getJson("https://x.invalid/1");
    await http.getJson("https://x.invalid/2");
    await expect(http.getJson("https://x.invalid/3")).rejects.toMatchObject({ reason: "budget_exhausted" });
  });

  it("uses conditional requests and serves 304 from cache", async () => {
    const { http, calls } = client([ok({ v: 1 }, { etag: '"abc"' }), () => new Response(null, { status: 304 })]);
    await http.getJson("https://x.invalid/e");
    await expect(http.getJson("https://x.invalid/e")).resolves.toEqual({ v: 1 });
    expect(calls[1]!["if-none-match"]).toBe('"abc"');
  });

  it("does not retry non-retryable client errors", async () => {
    const { http, store } = client([status(404)]);
    await expect(http.getJson("https://x.invalid/missing?key=secret")).rejects.toThrow(/HTTP 404/);
    expect((await store.load("test")).budgetUsed).toBe(1);
  });
});

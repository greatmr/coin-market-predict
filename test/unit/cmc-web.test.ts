import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { CmcWebClient, WEB_DETAIL, WEB_HISTORY, webResponseStatus } from "../../src/sources/coinmarketcap-web/client.js";
import { CoinMarketCapWebSource } from "../../src/sources/coinmarketcap-web/coinmarketcap-web.adapter.js";
import { parseCoinPage, parseWebDaily, parseWebHourly, parseWebLatest, parseWebListing, websiteData } from "../../src/sources/coinmarketcap-web/parse.js";
import { PoliteHttpClient } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";
import { parseExactJson } from "../../src/vmc/decimal.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const json = (name: string) => parseExactJson(fixture(name));
const NOW = new Date("2026-11-03T16:00:00Z");
const envelope = (data: unknown) => JSON.stringify({ status: { error_code: "0" }, data });

function client(respond: (url: URL, call: number) => Response, cacheMs = 0) {
  let ms = NOW.getTime(), calls = 0;
  const times: number[] = [];
  const headers: unknown[] = [];
  const store = new InMemorySourceHealthStore();
  const http = new PoliteHttpClient({ providerId: "web", requestsPerMinute: 6, monthlyBudget: 100, maxAttempts: 2, responseStatus: webResponseStatus, store, clock: { now: () => new Date(ms) }, sleep: async (delay) => { ms += delay; }, fetchImpl: (async (input, init) => { times.push(ms); headers.push(init?.headers ?? {}); return respond(new URL(String(input)), calls++); }) as typeof fetch });
  return { web: new CmcWebClient(http, cacheMs, () => new Date(ms)), store, times, headers };
}

describe("CoinMarketCap website parsing (trimmed real responses)", () => {
  it("reads a coin page by CMC id and uses circulating market cap and rolling volume", () => {
    const d = parseCoinPage(fixture("cmc-web-coin.html"), 52);
    const q = parseWebLatest(d, 52);
    expect(q.pair.valid).toBe(true);
    expect(q.pair.marketCap!.toString()).toBe(String((d.statistics as Record<string, unknown>).marketCap));
    expect(q.pair.marketCap!.toString()).not.toBe(String((d.statistics as Record<string, unknown>).fullyDilutedMarketCap));
    expect(q.observedAt!.toISOString()).toBe(d.latestUpdateTime);
    expect(() => parseCoinPage(fixture("cmc-web-coin.html"), 1)).toThrow(/id/);
  });

  it("preserves source digits for monetary calculations", () => {
    const body = parseExactJson('{"status":{"error_code":"0"},"data":{"id":52,"quotes":[{"timeOpen":"2026-11-02T00:00:00Z","timeClose":"2026-11-02T23:59:59.999Z","quote":{"name":"2781","volume":12345678901234567.89,"marketCap":20000000000000000.01}}]}}');
    const row = parseWebDaily(body, 52, NOW).rows[0]!;
    expect(row.volume!.toString()).toBe("12345678901234567.89");
    expect(row.marketCap!.toString()).toBe("20000000000000000.01");
  });

  it("assigns daily history to its own completed UTC day and excludes an open day", () => {
    const b = JSON.parse(fixture("cmc-web-history.json"));
    b.data.quotes.push({ timeOpen: "2026-11-03T00:00:00Z", timeClose: "2026-11-03T23:59:59.999Z", quote: { name: "2781", volume: 10, marketCap: 20 } });
    const parsed = parseWebDaily(b, 52, NOW);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.incompleteSkipped).toBe(1);
    expect(parsed.rows.at(-1)!.dateUtc).toBe("2026-11-02");
    expect(() => parseWebDaily(b, 1, NOW)).toThrow(/id/);
  });

  it("rejects zero cap/missing volume and non-USD history rather than substituting FDV", () => {
    const b = JSON.parse(fixture("cmc-web-history.json"));
    b.data.quotes[0].quote.marketCap = 0;
    b.data.quotes[1].quote.volume = null;
    b.data.quotes[2].quote.name = "BTC";
    expect(parseWebDaily(b, 52, NOW).rows.slice(0, 3).every((r) => !r.valid)).toBe(true);
  });

  it("uses the earliest real chart sample in each hour and respects range bounds", () => {
    const points = { "1793700000": { v: [10, 2, 100] }, "1793700900": { v: [11, 3, 110] }, "1793707200": { v: [20, 4, 200] } };
    const start = new Date(1793700000 * 1000), end = new Date(1793707199 * 1000);
    const rows = parseWebHourly(JSON.parse(envelope({ points })), 52, start, end);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ratio!.toString()).toBe("0.02");
    expect(rows[0]!.observedAt).toEqual(start);
    expect(parseWebHourly(json("cmc-web-chart.json"), 52, new Date("2026-11-03"), NOW).length).toBeGreaterThan(0);
  });

  it("parses website listing fields and primary contract without treating FDV as market cap", () => {
    const p = parseWebListing(json("cmc-web-listing.json"));
    expect(p.skipped).toBe(0);
    expect(p.total).toBe(8045);
    expect(p.observations.find((o) => o.providerAssetId === "1")).toMatchObject({ symbol: "BTC", marketCap: 1553655641898.8628, volume24h: 25234595702.145897 });
    expect(p.assets[0]!.platforms).toHaveLength(1);
  });

  it("rejects malformed and application-error envelopes", () => {
    expect(() => websiteData({ status: { error_code: "500" }, data: {} })).toThrow(/envelope/);
    expect(() => parseWebListing({ status: { error_code: 0 }, data: {} })).toThrow(/listing/);
  });
});

describe("website transport and coverage", () => {
  it("requires no API key and enforces the correct daily convention", () => {
    const env = { DATABASE_URL: "postgresql://x:x@localhost/test", DATA_SOURCE: "coinmarketcap_web", VMC_SOURCE: "cmc_web", VMC_DAILY_CONVENTION: "ohlcv" };
    expect(loadConfig(env).CMC_API_KEY).toBeUndefined();
    expect(() => loadConfig({ ...env, VMC_DAILY_CONVENTION: "eod_quote" })).toThrow(/ohlcv/);
  });

  it("serializes and spaces requests, caching identical requests while retaining raw provenance", async () => {
    const c = client(() => new Response(fixture("cmc-web-detail.json")), 60_000);
    const recorded: string[] = [];
    const record = async (r: { body: string }) => { recorded.push(r.body); return `raw-${recorded.length}`; };
    const results = await Promise.all([c.web.get(WEB_DETAIL, { id: 52 }, record), c.web.get(WEB_DETAIL, { id: 52 }, record), c.web.get(WEB_DETAIL, { id: 1 }, record)]);
    expect(c.times).toHaveLength(2);
    expect(c.times[1]! - c.times[0]!).toBeGreaterThanOrEqual(10_000);
    expect(results.map((r) => r.rawResponseId)).toEqual(["raw-1", "raw-2", "raw-3"]);
    expect(recorded[0]).toBe(recorded[1]);
    expect(JSON.stringify(c.headers)).not.toMatch(/X-CMC_PRO_API_KEY/);
  });

  it("falls back to website detail JSON if the coin page layout changes", async () => {
    const seen: string[] = [];
    const c = client((url) => { seen.push(url.pathname); return new Response(url.pathname.startsWith("/currencies/") ? "<html>New layout</html>" : fixture("cmc-web-detail.json")); });
    const r = await c.web.coin(52, "xrp");
    expect(parseWebLatest(r.body as Record<string, unknown>, 52).pair.valid).toBe(true);
    expect(seen).toEqual(["/currencies/xrp/", WEB_DETAIL]);
  });

  it("stops on a challenge instead of retrying through a different route", async () => {
    const c = client(() => new Response("<html>Just a moment cf-chl-</html>"));
    await expect(c.web.coin(52, "xrp")).rejects.toMatchObject({ kind: "auth" });
    expect(c.times).toHaveLength(1);
  });

  it("resolves a renamed coin page through the id-based detail endpoint", async () => {
    const c = client((url) => url.pathname.startsWith("/currencies/") ? new Response("gone", { status: 404 }) : new Response(fixture("cmc-web-detail.json")));
    expect((await c.web.coin(52, "old-slug")).endpoint).toBe(WEB_DETAIL);
  });

  it("honors HTTP-200 application rate limits and records the original error body", async () => {
    const c = client((_url, call) => new Response(call === 0 ? '{"status":{"error_code":"429","error_message":"Too many requests"}}' : fixture("cmc-web-detail.json"), { headers: { "retry-after": "30" } }));
    const bodies: string[] = [];
    await c.web.get(WEB_DETAIL, { id: 52 }, async (r) => { bodies.push(r.body); return "raw"; });
    expect(c.times[1]! - c.times[0]!).toBeGreaterThanOrEqual(30_000);
    expect(bodies[0]).toContain("429");
    expect((await c.store.load("web")).budgetUsed).toBe(2);
  });

  it("treats the supplied invalid 3d interval as an error rather than empty history", async () => {
    const c = client(() => new Response('{"status":{"error_code":"500","error_message":"Unexpected value: 3d"}}'));
    await expect(c.web.get(WEB_HISTORY, { interval: "3d" })).rejects.toThrow(/HTTP 400/);
    expect(c.times).toHaveLength(1);
  });

  it("persists cooldown even when the last retry is rate limited", async () => {
    const c = client(() => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    await expect(c.web.get(WEB_DETAIL, { id: 52 })).rejects.toMatchObject({ kind: "rate_limited" });
    expect(c.times).toHaveLength(2);
    expect((await c.store.load("web")).retryAfterUntil).not.toBeNull();
    await expect(c.web.get(WEB_DETAIL, { id: 52 })).rejects.toMatchObject({ kind: "rate_limited" });
    expect(c.times).toHaveLength(2);
  });

  it("deduplicates featured coins and reports capped or repeated pagination as partial", async () => {
    const b = JSON.parse(fixture("cmc-web-listing.json"));
    const c = client(() => new Response(JSON.stringify(b)));
    const source = new CoinMarketCapWebSource(c.web, 3);
    const result = await source.discover();
    expect(result.complete).toBe(false);
    expect(result.pagesFetched).toBe(2);
    expect(result.assets).toHaveLength(3);
    expect((await source.collect({ slot: NOW, maxPages: 1 })).complete).toBe(false);
  });

  it("reports full coverage only after the reported universe has been collected", async () => {
    const b = JSON.parse(fixture("cmc-web-listing.json"));
    b.data.totalCount = "3";
    const c = client(() => new Response(JSON.stringify(b)));
    expect((await new CoinMarketCapWebSource(c.web).discover()).complete).toBe(true);
    b.data.cryptoCurrencyList[0].quotes = [];
    expect((await new CoinMarketCapWebSource(c.web, 1).discover()).complete).toBe(false);
  });

  it("keeps previously collected pages when a later page fails, without claiming full coverage", async () => {
    const c = client((_url, call) => call === 0 ? new Response(fixture("cmc-web-listing.json")) : new Response("denied", { status: 403 }));
    const r = await new CoinMarketCapWebSource(c.web).collect({ slot: NOW, maxPages: 3 });
    expect(r.observations).toHaveLength(3);
    expect(r.complete).toBe(false);
    expect(r.requestsUsed).toBe(2);
    expect(r.notes.join(" ")).toMatch(/stopped on page 2/);
  });

  it("reuses bounded discovery listings for collection without repeating all HTTP requests", async () => {
    const c = client(() => new Response(fixture("cmc-web-listing.json")));
    const source = new CoinMarketCapWebSource(c.web, 1);
    expect((await source.discover()).pagesFetched).toBe(1);
    const collected = await source.collect({ slot: NOW, maxPages: 1 });
    expect(collected.observations).toHaveLength(3);
    expect(collected.requestsUsed).toBe(0);
    expect(collected.complete).toBe(false);
    expect(c.times).toHaveLength(1);
  });
});

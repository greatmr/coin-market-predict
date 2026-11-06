import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseExactJson } from "../../src/common/decimal.js";
import { CmcWebClient, WEB_COIN_PAIRS, WEB_EXCHANGE_PAIRS, WEB_HISTORY, WEB_LISTING, webResponseStatus } from "../../src/sources/coinmarketcap-web/client.js";
import { CmcWebTier1Source, CoinMarketCapWebSource } from "../../src/sources/coinmarketcap-web/coinmarketcap-web.adapter.js";
import { stopsCrawl } from "../../src/sources/coinmarketcap-web/errors.js";
import { parseVenuePairs, parseWebDaily, parseWebListing, websiteData } from "../../src/sources/coinmarketcap-web/parse.js";
import { PoliteHttpClient } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";

/** Trimmed real public CMC responses (listing/history 2026-11-03, market pairs 2026-11-05). */
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const json = (name: string) => parseExactJson(fixture(name));
const NOW = new Date("2026-11-03T16:00:00Z");

function client(respond: (url: URL, call: number) => Response, cacheMs = 0) {
  let ms = NOW.getTime(), calls = 0;
  const times: number[] = [];
  const urls: URL[] = [];
  const headers: unknown[] = [];
  const store = new InMemorySourceHealthStore();
  const http = new PoliteHttpClient({ providerId: "web", requestsPerMinute: 6, monthlyBudget: 100, maxAttempts: 2, responseStatus: webResponseStatus, store, clock: { now: () => new Date(ms) }, sleep: async (delay) => { ms += delay; }, fetchImpl: (async (input, init) => { times.push(ms); const u = new URL(String(input)); urls.push(u); headers.push(init?.headers ?? {}); return respond(u, calls++); }) as typeof fetch });
  return { web: new CmcWebClient(http, cacheMs, () => new Date(ms)), store, times, urls, headers };
}

describe("CMC website listing (gaps G1–G3)", () => {
  it("keeps cmcRank, dateAdded, raw tags and slug next to the USD quote", () => {
    const p = parseWebListing(json("cmc-web-listing.json"));
    expect(p.skipped).toBe(0);
    expect(p.total).toBe(8045);
    const btc = p.observations.find((o) => o.providerAssetId === "1")!;
    expect(btc).toMatchObject({ symbol: "BTC", rank: 1, slug: "bitcoin", marketCap: 1553655641898.8628, volume24h: 25234595702.145897 });
    expect(btc.dateAdded!.toISOString()).toBe("2010-07-13T00:00:00.000Z");
    expect(btc.tags).toContain("layer-1");
    expect(btc.observedAt!.toISOString()).toBe("2026-11-03T15:36:03.026Z");
    // Featured index row: no cmcRank → null (RANK_MISSING downstream), never a page-number guess.
    expect(p.observations.find((o) => o.providerAssetId === "38442")!.rank).toBeNull();
    expect(p.observations.find((o) => o.providerAssetId === "38442")!.platform).toEqual({ chain: "bnb", address: "0x2f8A339B5889FfaC4c5A956787cdA593b3c36867" });
  });

  it("rejects malformed and application-error envelopes", () => {
    expect(() => websiteData({ status: { error_code: "500" }, data: {} })).toThrow(/envelope/);
    expect(() => parseWebListing({ status: { error_code: 0 }, data: {} })).toThrow(/listing/);
  });
});

describe("CMC website daily history (completed UTC days)", () => {
  it("keeps exact source digits and the close price; skips the open day", () => {
    const b = JSON.parse(fixture("cmc-web-history.json"));
    b.data.quotes.push({ timeOpen: "2026-11-03T00:00:00.000Z", timeClose: "2026-11-03T23:59:59.999Z", quote: { name: "2781", volume: 10, marketCap: 20 } });
    const parsed = parseWebDaily(parseExactJson(JSON.stringify(b)), 52, NOW);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.incompleteSkipped).toBe(1);
    expect(parsed.rows[0]).toMatchObject({ dateUtc: "2026-10-30", volume: "3896970078.85", marketCap: "79469228389.15", close: "1.2544089281", invalidReasons: [] });
    expect(parsed.rows[0]!.sourceCloseAt!.toISOString()).toBe("2026-10-30T23:59:59.999Z");
    expect(() => parseWebDaily(b, 1, NOW)).toThrow(/id/);
  });

  it("preserves source digits beyond floating-point precision", () => {
    const body = parseExactJson('{"status":{"error_code":"0"},"data":{"id":52,"quotes":[{"timeOpen":"2026-11-02T00:00:00.000Z","timeClose":"2026-11-02T23:59:59.999Z","quote":{"name":"2781","volume":12345678901234567.89,"marketCap":20000000000000000.01}}]}}');
    const row = parseWebDaily(body, 52, NOW).rows[0]!;
    expect(row.volume).toBe("12345678901234567.89");
    expect(row.marketCap).toBe("20000000000000000.01");
  });

  it("marks non-USD quotes and periods that are not one UTC day invalid instead of guessing", () => {
    const b = JSON.parse(fixture("cmc-web-history.json"));
    b.data.quotes[0].quote.name = "BTC";
    b.data.quotes[1].timeOpen = "2026-10-31T04:00:00.000Z";
    const rows = parseWebDaily(b, 52, NOW).rows;
    expect(rows.find((r) => r.dateUtc === "2026-10-30")!.invalidReasons).toContain("quote_not_usd");
    expect(rows.find((r) => r.dateUtc === "2026-10-31")!.invalidReasons).toContain("period_not_one_utc_day");
  });
});

describe("CMC market pairs (gaps G6, G7)", () => {
  it("parses LBank spot pairs with CMC's own base-asset id and no invented trading status", () => {
    const p = parseVenuePairs(json("cmc-web-lbank-pairs.json"));
    expect(p.expected).toBe(900);
    expect(p.pairs[0]).toMatchObject({ exchange: "lbank", marketPair: "BTC/USDT", category: "spot", baseSymbol: "BTC", baseCurrencyId: 1, quoteSymbol: "USDT", quoteCurrencyId: 825, volumeUsd: "259086321.36423135", tradingStatus: null, lastUpdated: "2026-11-05T06:06:11.000Z" });
    expect(p.pairs.every((x) => x.tradingStatus === null)).toBe(true);
  });

  it("parses a coin's Markets table with per-pair USD volume and share", () => {
    const p = parseVenuePairs(json("cmc-web-market-pairs.json"));
    expect(p.expected).toBe(500);
    expect(p.pairs.map((x) => x.exchange)).toEqual(expect.arrayContaining(["binance", "coinbase-exchange", "okx"]));
    expect(p.pairs.every((x) => x.baseCurrencyId === 2 && x.category === "spot")).toBe(true);
    expect(p.pairs[0]!.volumePercent).toBe("6.276960259101");
  });

  it("pages LBank pairs by what the server returns and reports partial coverage honestly", async () => {
    const page = JSON.parse(fixture("cmc-web-lbank-pairs.json"));
    const c = client(() => new Response(JSON.stringify(page)));
    const r = await new CmcWebTier1Source(c.web).lbankSpotPairs();
    expect(r.complete).toBe(false); // the same 5 rows come back: 5 of 900 reported pairs
    expect(r.pairs).toHaveLength(5);
    expect(r.notes.join(" ")).toMatch(/partial LBank pair list: 5\/900/);
    expect(c.urls[0]!.pathname).toBe(WEB_EXCHANGE_PAIRS);
    expect(c.urls[0]!.searchParams.get("slug")).toBe("lbank");
    page.data.numMarketPairs = 5;
    expect((await new CmcWebTier1Source(client(() => new Response(JSON.stringify(page))).web).lbankSpotPairs()).complete).toBe(true);
  });

  it("keeps two assets that share a pair name and survives a ranking shift between page requests", async () => {
    const template = JSON.parse(fixture("cmc-web-lbank-pairs.json")).data.marketPairs[0];
    const row = (i: number, extra: Record<string, unknown> = {}) => ({ ...template, rank: i, marketId: 100_000 + i, marketPair: `T${i}/USDT`, baseSymbol: `T${i}`, baseCurrencyId: 500_000 + i, ...extra });
    // 1,100 pairs; two different CMC assets are both listed as "DUP/USDT" (different market ids).
    const rows = Array.from({ length: 1100 }, (_, k) => row(k + 1));
    rows[10] = row(11, { marketPair: "DUP/USDT", baseSymbol: "DUP", baseCurrencyId: 111 });
    rows[20] = row(21, { marketPair: "DUP/USDT", baseSymbol: "DUP", baseCurrencyId: 222 });
    let served = 0;
    const c = client((u) => {
      const start = Number(u.searchParams.get("start")), limit = Number(u.searchParams.get("limit"));
      // After the first page, the pairs at positions 499 and 502 swap places (volume moved): a
      // pager that advanced by exactly one page would never see the pair that moved backwards.
      const view = served++ === 0 ? rows : rows.map((r, k) => (k === 498 ? rows[501] : k === 501 ? rows[498] : r));
      return new Response(JSON.stringify({ status: { error_code: "0" }, data: { numMarketPairs: 1100, marketPairs: view.slice(start - 1, start - 1 + limit) } }));
    });
    const r = await new CmcWebTier1Source(c.web).lbankSpotPairs();
    expect(r.complete).toBe(true);
    expect(r.pairs).toHaveLength(1100);
    expect(r.pairs.filter((p) => p.marketPair === "DUP/USDT").map((p) => p.baseCurrencyId).sort()).toEqual([111, 222]);
    expect(new Set(r.pairs.map((p) => p.marketId)).size).toBe(1100);
    expect(c.urls.map((u) => u.searchParams.get("start"))).toEqual(["1", "451", "901"]);
  });

  it("requires a usable slug for a coin's Markets table", async () => {
    const c = client(() => new Response(fixture("cmc-web-market-pairs.json")));
    const src = new CmcWebTier1Source(c.web);
    await expect(src.assetMarkets({ cmcId: 2, slug: null })).rejects.toMatchObject({ kind: "bad_request" });
    const r = await src.assetMarkets({ cmcId: 2, slug: "litecoin" });
    expect(r).toMatchObject({ complete: false, expectedCount: 500 });
    expect(c.urls[0]!.pathname).toBe(WEB_COIN_PAIRS);
  });

  it("requests completed days only and filters rows outside the requested range", async () => {
    const c = client(() => new Response(fixture("cmc-web-history.json")));
    const r = await new CmcWebTier1Source(c.web).dailyHistory({ cmcId: 52 }, "2026-10-31", "2026-11-01", NOW);
    expect(r.rows.map((x) => x.dateUtc)).toEqual(["2026-10-31", "2026-11-01"]);
    expect(r.outOfRange).toBe(2);
    expect(c.urls[0]!.pathname).toBe(WEB_HISTORY);
    expect(c.urls[0]!.searchParams.get("interval")).toBe("1d");
    expect(r.responseSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("website transport and coverage", () => {
  it("serializes and spaces requests and caches identical ones; no API key is sent", async () => {
    const c = client(() => new Response(fixture("cmc-web-history.json")), 60_000);
    await Promise.all([c.web.get(WEB_HISTORY, { id: 52 }), c.web.get(WEB_HISTORY, { id: 52 }), c.web.get(WEB_HISTORY, { id: 1 })]);
    expect(c.times).toHaveLength(2);
    expect(c.times[1]! - c.times[0]!).toBeGreaterThanOrEqual(10_000);
    expect(JSON.stringify(c.headers)).not.toMatch(/X-CMC_PRO_API_KEY/);
  });

  it("only allows the documented website routes", async () => {
    const c = client(() => new Response("{}"));
    await expect(c.web.get("/data-api/v3/cryptocurrency/detail", { id: 1 })).rejects.toThrow(/Unsupported/);
    await expect(c.web.get(WEB_LISTING, {})).rejects.toBeDefined();
  });

  it("stops on a challenge page and classifies it as access denial", async () => {
    const c = client(() => new Response("<html>Just a moment cf-chl-</html>"));
    const err = await c.web.get(WEB_HISTORY, { id: 52 }).catch((e) => e);
    expect(err).toMatchObject({ kind: "auth" });
    expect(stopsCrawl(err)).toBe(true);
    expect(c.times).toHaveLength(1);
  });

  it("honors HTTP-200 application rate limits", async () => {
    const c = client((_url, call) => new Response(call === 0 ? '{"status":{"error_code":"429","error_message":"Too many requests"}}' : fixture("cmc-web-history.json"), { headers: { "retry-after": "30" } }));
    await c.web.get(WEB_HISTORY, { id: 52 });
    expect(c.times[1]! - c.times[0]!).toBeGreaterThanOrEqual(30_000);
    expect((await c.store.load("web")).budgetUsed).toBe(2);
  });

  it("treats an invalid interval as an error rather than empty history", async () => {
    const c = client(() => new Response('{"status":{"error_code":"500","error_message":"Unexpected value: 3d"}}'));
    const err = await c.web.get(WEB_HISTORY, { interval: "3d" }).catch((e) => e);
    expect(String(err)).toMatch(/HTTP 400/);
    expect(stopsCrawl(err)).toBe(false);
  });

  it("deduplicates featured coins and reports capped or repeated pagination as partial", async () => {
    const b = JSON.parse(fixture("cmc-web-listing.json"));
    const c = client(() => new Response(JSON.stringify(b)));
    const source = new CoinMarketCapWebSource(c.web, 3);
    const result = await source.discover();
    expect(result.complete).toBe(false);
    expect(result.pagesFetched).toBe(2);
    expect(result.assets).toHaveLength(3);
  });

  it("reports full coverage only after the reported universe has been collected", async () => {
    const b = JSON.parse(fixture("cmc-web-listing.json"));
    b.data.totalCount = "3";
    const c = client(() => new Response(JSON.stringify(b)));
    expect((await new CoinMarketCapWebSource(c.web).discover()).complete).toBe(true);
  });

  it("keeps previously collected pages when a later page fails, without claiming full coverage", async () => {
    const c = client((_url, call) => (call === 0 ? new Response(fixture("cmc-web-listing.json")) : new Response("denied", { status: 403 })));
    const r = await new CoinMarketCapWebSource(c.web).collect({ slot: NOW, maxPages: 3 });
    expect(r.observations).toHaveLength(3);
    expect(r.complete).toBe(false);
    expect(r.notes.join(" ")).toMatch(/stopped on page 2/);
  });
});

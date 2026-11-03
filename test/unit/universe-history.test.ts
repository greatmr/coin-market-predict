import { describe, expect, it } from "vitest";
import { addHours, HOUR_MS } from "../../src/common/time.js";
import { classifyAsset, PEGGED_USD, stricterClass, trackedExposure } from "../../src/ingestion/classify.js";
import { alignToHourlySlots, slotOffsetMs, stopsBackfill } from "../../src/ingestion/history.js";
import { trackerEvidence } from "../../src/ingestion/ingestion.service.js";
import { cmcCategories } from "../../src/sources/coinmarketcap/coinmarketcap.adapter.js";
import { countReasons, eligibilityExclusions, inScreenUniverse, wantsHistory } from "../../src/screening/universe.js";
import { CmcWebClient, webResponseStatus } from "../../src/sources/coinmarketcap-web/client.js";
import { CoinMarketCapWebSource } from "../../src/sources/coinmarketcap-web/coinmarketcap-web.adapter.js";
import { parseWebMarketHistory } from "../../src/sources/coinmarketcap-web/parse.js";
import { PoliteHttpClient, SourceUnavailableError } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";
import type { RawObservation } from "../../src/sources/types.js";
import { CmcApiError } from "../../src/vmc/cmc-client.js";

const SLOT = new Date("2026-11-03T16:00:00Z");
const floors = { minMarketCapUsd: 5e6, minVolume24hUsd: 250_000 };
const regular = { assetClass: "regular", isBenchmark: false };
const quote = (o: Partial<{ price: number | null; marketCap: number | null; volumeRolling24h: number | null; isStale: boolean }> = {}) => ({ price: 1, marketCap: 50e6, volumeRolling24h: 5e6, isStale: false, ...o });
const sample = (iso: string, price: number): RawObservation => ({ providerAssetId: "7", name: "Seven", symbol: "SVN", sourceUrl: "https://coinmarketcap.com/currencies/seven/", observedAt: new Date(iso), price, marketCap: 10e6, volume24h: 1e6, circulatingSupply: null, fullyDilutedValuation: null });

describe("strategy universe rules (shared by features, screening, backfill and dashboard)", () => {
  it("evaluates benchmarks and non-excluded coins at or above the market-cap floor only", () => {
    expect(inScreenUniverse(regular, quote(), floors)).toBe(true);
    expect(inScreenUniverse(regular, quote({ volumeRolling24h: 10 }), floors)).toBe(true); // illiquid is a screening exclusion, still evaluated
    expect(inScreenUniverse(regular, quote({ marketCap: 4.9e6 }), floors)).toBe(false);
    expect(inScreenUniverse(regular, quote({ marketCap: null }), floors)).toBe(false);
    expect(inScreenUniverse({ assetClass: "stablecoin", isBenchmark: false }, quote(), floors)).toBe(false);
    expect(inScreenUniverse({ assetClass: "regular", isBenchmark: true }, quote({ marketCap: null }), floors)).toBe(true);
  });

  it("wants history only for coins that would be eligible now, plus fresh priced benchmarks", () => {
    expect(wantsHistory(regular, quote(), floors)).toBe(true);
    expect(wantsHistory(regular, quote({ volumeRolling24h: 100_000 }), floors)).toBe(false);
    expect(wantsHistory(regular, quote({ isStale: true }), floors)).toBe(false);
    expect(wantsHistory(regular, quote({ price: null }), floors)).toBe(false);
    expect(wantsHistory({ assetClass: "wrapped", isBenchmark: false }, quote(), floors)).toBe(false);
    expect(wantsHistory({ assetClass: "regular", isBenchmark: true }, quote({ volumeRolling24h: 1 }), floors)).toBe(true);
    expect(wantsHistory({ assetClass: "regular", isBenchmark: true }, quote({ isStale: true }), floors)).toBe(false);
  });

  it("reports every applicable exclusion and counts them per reason", () => {
    const tiny = eligibilityExclusions(regular, quote({ marketCap: 1e6, volumeRolling24h: 1_000 }), floors);
    expect(tiny).toEqual(["illiquid_volume", "below_min_market_cap"]);
    expect(eligibilityExclusions({ assetClass: "stablecoin", isBenchmark: false }, null, floors)).toEqual(["excluded_class:stablecoin", "no_current_snapshot"]);
    expect(countReasons([tiny, ["below_min_market_cap"], []])).toEqual({ illiquid_volume: 1, below_min_market_cap: 2 });
  });
});

describe("genuine hourly history alignment", () => {
  it("samples each previous hour at the current observation's minute offset", () => {
    const samples = [
      sample("2026-11-03T15:00:00Z", 1.0),
      sample("2026-11-03T15:15:00Z", 1.1),
      sample("2026-11-03T15:30:00Z", 1.2),
      sample("2026-11-03T15:45:00Z", 1.3),
      sample("2026-11-03T14:10:00Z", 2.0),
      sample("2026-11-03T14:55:00Z", 2.1),
    ];
    const rows = alignToHourlySlots(samples, SLOT, 72, slotOffsetMs(SLOT, new Date("2026-11-03T16:20:00Z")));
    expect(rows.map((r) => [r.slotTime.toISOString(), r.raw.price])).toEqual([
      ["2026-11-03T14:00:00.000Z", 2.0], // 14:10 is closer to 14:20 than 14:55
      ["2026-11-03T15:00:00.000Z", 1.1], // 15:15 is closest to 15:20
    ]);
  });

  it("never uses the current hour or samples older than the window, and leaves gaps missing", () => {
    const samples = [sample("2026-11-03T16:05:00Z", 9), sample("2026-11-03T13:00:00Z", 3), sample("2026-11-03T10:59:59Z", 1)];
    const rows = alignToHourlySlots(samples, SLOT, 5, 0);
    expect(rows.map((r) => r.slotTime.toISOString())).toEqual(["2026-11-03T13:00:00.000Z"]);
  });

  it("breaks ties toward the earlier sample and falls back to the hour start for lagged observations", () => {
    const rows = alignToHourlySlots([sample("2026-11-03T15:40:00Z", 2), sample("2026-11-03T15:20:00Z", 1)], SLOT, 3, 30 * 60_000);
    expect(rows[0]!.raw.price).toBe(1);
    expect(slotOffsetMs(SLOT, new Date("2026-11-03T15:36:00Z"))).toBe(0);
    expect(slotOffsetMs(SLOT, null)).toBe(0);
    expect(slotOffsetMs(SLOT, new Date(SLOT.getTime() + HOUR_MS - 1))).toBe(HOUR_MS - 1);
  });

  it("returns every chart sample in range, oldest first, without treating FDV as market cap", () => {
    const pts: Record<string, { v: number[] }> = {};
    for (let i = 0; i < 8; i++) pts[String(SLOT.getTime() / 1000 - i * 900)] = { v: [10 + i, 1000, 5000 + i] };
    const body = { status: { error_code: "0" }, data: { points: { ...pts, bad: { v: [1] } } } };
    const out = parseWebMarketHistory(body, { providerAssetId: "7", name: "Seven", symbol: "SVN", sourceUrl: "u", platforms: [] }, addHours(SLOT, -1), new Date(SLOT.getTime() - 1));
    expect(out).toHaveLength(4);
    expect(out.map((o) => o.observedAt!.toISOString())).toEqual(["2026-11-03T15:00:00.000Z", "2026-11-03T15:15:00.000Z", "2026-11-03T15:30:00.000Z", "2026-11-03T15:45:00.000Z"]);
    expect(out[0]).toMatchObject({ price: 14, volume24h: 1000, marketCap: 5004, circulatingSupply: null, fullyDilutedValuation: null });
  });

  it("stops the backfill on denial, rate limits, budget or an open circuit but skips one failing coin", () => {
    // A transient 5xx/network error for one coin (seen live: HTTP 502 for TRX) skips that coin only.
    for (const kind of ["invalid_response", "bad_request", "server", "network"] as const) expect(stopsBackfill(new CmcApiError(kind, kind, null, null))).toBe(false);
    for (const kind of ["auth", "rate_limited", "budget", "billing", "credits_exhausted", "plan_not_authorized"] as const) expect(stopsBackfill(new CmcApiError(kind, kind, null, null))).toBe(true);
    expect(stopsBackfill(new SourceUnavailableError("suspended", "suspended"))).toBe(true);
    expect(stopsBackfill(new Error("database unavailable"))).toBe(true);
  });
});

/** Synthetic website listing ordered by rank; the server may cap the page size or reorder between requests. */
function listingServer(totalCoins: number, opts: { serverCap?: number; swapAfterFirstPage?: number; reverseTailFrom?: number } = {}) {
  const ids = Array.from({ length: totalCoins }, (_, i) => i + 1);
  const seen: Array<{ start: number; limit: number }> = [];
  let ms = SLOT.getTime();
  const item = (id: number) => ({
    id, name: `Coin ${id}`, symbol: `C${id}`, slug: `coin-${id}`, tags: [], circulatingSupply: 1000,
    quotes: [{ name: "USD", price: 1, volume24h: 1e6, marketCap: 1e7, percentChange1h: 0, percentChange24h: 0, percentChange7d: 0, lastUpdated: SLOT.toISOString() }],
  });
  const http = new PoliteHttpClient({
    providerId: "web", requestsPerMinute: 60, monthlyBudget: 1000, maxAttempts: 1, responseStatus: webResponseStatus, store: new InMemorySourceHealthStore(),
    clock: { now: () => new Date(ms) }, sleep: async (d) => { ms += d; },
    fetchImpl: (async (input) => {
      const u = new URL(String(input));
      const start = Number(u.searchParams.get("start")), limit = Number(u.searchParams.get("limit"));
      seen.push({ start, limit });
      // Between page requests the coin at the boundary changes rank (moves up by one).
      if (opts.swapAfterFirstPage !== undefined && seen.length === 2) { const b = opts.swapAfterFirstPage; [ids[b - 1], ids[b]] = [ids[b]!, ids[b - 1]!]; }
      const n = Math.min(limit, opts.serverCap ?? limit);
      // Tied rows (e.g. thousands of zero-cap coins) come back in a different order on alternate requests.
      const order = opts.reverseTailFrom !== undefined && seen.length % 2 === 0 ? [...ids.slice(0, opts.reverseTailFrom), ...ids.slice(opts.reverseTailFrom).reverse()] : ids;
      const page = order.slice(start - 1, start - 1 + n).map(item);
      return new Response(JSON.stringify({ status: { error_code: "0" }, data: { cryptoCurrencyList: page, totalCount: String(totalCoins) } }));
    }) as typeof fetch,
  });
  return { web: new CmcWebClient(http, 0, () => new Date(ms)), seen };
}

describe("website listing pagination covers the whole universe", () => {
  it("reads all 8,041 coins in one request at the default 10,000 page size", async () => {
    const s = listingServer(8041);
    const r = await new CoinMarketCapWebSource(s.web, 10).discover();
    expect(r).toMatchObject({ complete: true, sourceTotal: 8041, pagesFetched: 1 });
    expect(r.assets).toHaveLength(8041);
    expect(s.seen).toEqual([{ start: 1, limit: 10_000 }]);
  });

  it("never claims full coverage when paged results repeat or drop coins (unstable tie order)", async () => {
    // Seen live with 5,000-row pages: thousands of zero-cap coins tie, so later pages repeat some and skip others.
    const s = listingServer(300, { reverseTailFrom: 50 });
    const r = await new CoinMarketCapWebSource(s.web, 10, 100).collect({ slot: SLOT, maxPages: 10 });
    const unique = new Set(r.observations.map((o) => o.providerAssetId)).size;
    expect(unique).toBeLessThan(300);
    expect(r.complete).toBe(false);
    expect(r.notes.join(" ")).toMatch(new RegExp(`partial website coverage: ${unique}/300`));
  });

  it("advances by the rows actually returned when the server caps the page size", async () => {
    const s = listingServer(1000, { serverCap: 120 });
    const r = await new CoinMarketCapWebSource(s.web, 20, 500).collect({ slot: SLOT, maxPages: 20 });
    expect(r.complete).toBe(true);
    expect(new Set(r.observations.map((o) => o.providerAssetId)).size).toBe(1000);
    expect(s.seen.every((x, i) => i === 0 || x.start === s.seen[i - 1]!.start + 120 - 25)).toBe(true);
  });

  it("re-reads a few boundary rows so a coin that changed rank between pages is not missed", async () => {
    // Coin 101 moves up to rank 100 after page 1 (ranks 1–100) was read.
    const s = listingServer(300, { swapAfterFirstPage: 100 });
    const r = await new CoinMarketCapWebSource(s.web, 5, 100).collect({ slot: SLOT, maxPages: 5 });
    expect(s.seen[1]!.start).toBeLessThanOrEqual(100);
    expect(new Set(r.observations.map((o) => o.providerAssetId)).size).toBe(300);
    expect(r.complete).toBe(true);
  });

  it("reports partial coverage honestly when the page cap is reached", async () => {
    const s = listingServer(1000);
    const r = await new CoinMarketCapWebSource(s.web, 2, 100).collect({ slot: SLOT, maxPages: 2 });
    expect(r.complete).toBe(false);
    expect(r.notes.join(" ")).toMatch(/partial website coverage: 195\/1000/);
  });
});

describe("classification of tracked exposure (excluded from the strategy)", () => {
  const refs = { bitcoin: 77_500, ethereum: 2_286, solana: 93, binancecoin: 696 };
  const obs = (symbol: string, name: string, price: number, ch24 = 0.1, ch7 = 0.2): RawObservation => ({ providerAssetId: symbol, name, symbol, sourceUrl: "u", observedAt: SLOT, price, marketCap: 1e8, volume24h: 1e7, circulatingSupply: null, fullyDilutedValuation: null, changePct24h: ch24, changePct7d: ch7 });

  it("maps only unambiguous CoinMarketCap tags", () => {
    expect(cmcCategories(["stablecoin", "usd-stablecoin", "fiat-stablecoin"])).toEqual(["stablecoins"]);
    expect(cmcCategories(["stablecoin-protocol", "defi"])).toEqual([]); // governance tokens such as STABLE, FF, XPL
    expect(cmcCategories(["liquid-staking-derivatives", "restaking"])).toEqual([]); // also tags LDO, RPL, PENDLE
    expect(cmcCategories(["tokenized-stock", "tokenized-assets"])).toEqual(["tokenized-assets"]);
    expect(cmcCategories(["tokenized-gold"])).toEqual(["tokenized-assets"]);
    expect(cmcCategories(["tokenized-assets"])).toEqual([]); // too broad on its own (RWA protocol tokens)
    expect(classifyAsset({ name: "Tesla xStock", symbol: "TSLAX", categories: cmcCategories(["tokenized-stock"]) })).toMatchObject({ assetClass: "tokenized", classSource: "provider_category" });
    expect(stricterClass("regular", "tokenized")).toBe(true);
    expect(stricterClass("tokenized", "wrapped")).toBe(false);
  });

  it("flags wrapped, staked and bridged variants that trade near their underlying and name it", () => {
    expect(trackedExposure(obs("WSTETH", "Lido wstETH", 2_863), refs)).toBe("tracks:ethereum");
    expect(trackedExposure(obs("LBTC", "Lombard BTC", 77_250), refs)).toBe("tracks:bitcoin");
    expect(trackedExposure(obs("BTCB", "Bitcoin BEP2", 77_521), refs)).toBe("tracks:bitcoin");
    expect(trackedExposure(obs("slisBNBx", "slisBNBx", 695), refs)).toBe("tracks:binancecoin");
    expect(trackedExposure(obs("JITOSOL", "Jito Staked SOL", 122), refs)).toBe("tracks:solana");
    expect(classifyAsset({ name: "Lido wstETH", symbol: "WSTETH", categories: ["tracks:ethereum"] })).toMatchObject({ assetClass: "wrapped", classSource: "heuristic_price", underlyingAsset: "ethereum" });
  });

  it("does not flag coins that merely share a name or a price", () => {
    expect(trackedExposure(obs("BCH", "Bitcoin Cash", 274), refs)).toBeNull();
    expect(trackedExposure(obs("ETC", "Ethereum Classic", 16), refs)).toBeNull();
    expect(trackedExposure(obs("XMR", "Monero", 2_300), refs)).toBeNull(); // ETH-like price, no ETH in name
    expect(trackedExposure(obs("ONE", "Harmony", 1.0), refs)).toBeNull(); // $1 without a USD name
    expect(trackedExposure(obs("USDX", "Volatile USD Index", 1.0, 2.5, 4), refs)).toBeNull(); // not pinned
    expect(trackedExposure(obs("RWUSD", "RWUSD", 0.998, 0.01, 0.05), refs)).toBe(PEGGED_USD);
    expect(trackedExposure({ ...obs("X", "X", 1), price: null }, refs)).toBeNull();
  });

  it("collects evidence per slot without flagging the reference coins themselves", () => {
    const list = [
      { ...obs("1", "Bitcoin", 77_500), symbol: "BTC" },
      { ...obs("1027", "Ethereum", 2_286), symbol: "ETH" },
      { ...obs("12409", "Lido wstETH", 2_860), symbol: "WSTETH" },
      { ...obs("2", "Litecoin", 54), symbol: "LTC" },
    ];
    const ev = trackerEvidence("coinmarketcap_web", list);
    expect([...ev.entries()]).toEqual([["12409", ["tracks:ethereum"]]]);
    expect(trackerEvidence("unknown_provider", list).size).toBe(0);
  });
});

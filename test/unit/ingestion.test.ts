import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyAsset, stricterClass } from "../../src/ingestion/classify.js";
import { normalizeContract, sanitizeText, validateObservation } from "../../src/ingestion/validate.js";
import { parseCoinGeckoList, parseCoinGeckoMarkets } from "../../src/sources/coingecko/coingecko.adapter.js";
import { cmcCategories, parseCmcListings } from "../../src/sources/coinmarketcap/coinmarketcap.adapter.js";
import type { RawObservation } from "../../src/sources/types.js";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8"));
const slot = new Date("2026-11-03T12:00:00Z");
const collectedAt = new Date("2026-11-03T12:07:00Z");
const opts = { slotTime: slot, collectedAt, staleAfterMinutes: 90 };

const raw = (o: Partial<RawObservation> = {}): RawObservation => ({
  providerAssetId: "x",
  name: "X",
  symbol: "x",
  sourceUrl: "https://example.invalid/x",
  observedAt: new Date("2026-11-03T12:03:00Z"),
  price: 2,
  marketCap: 2_000_000,
  fullyDilutedValuation: 9_000_000,
  circulatingSupply: 1_000_000,
  volume24h: 500_000,
  ...o,
});

describe("CoinMarketCap parser", () => {
  it("parses documented listing fields, skips malformed rows, keeps nulls", () => {
    const r = parseCmcListings(fixture("cmc-listings-latest.json"));
    expect(r.observations).toHaveLength(3);
    expect(r.skipped).toBe(1);
    expect(r.totalCount).toBe(8049);
    const btc = r.observations.find((o) => o.providerAssetId === "1")!;
    expect(btc.price).toBe(100000.5);
    expect(btc.volume24h).toBe(30_000_000_000);
    expect(btc.observedAt?.toISOString()).toBe("2026-11-03T12:04:00.000Z");
    expect(btc.sourceUrl).toBe("https://coinmarketcap.com/currencies/bitcoin/");
    const usdt = r.observations.find((o) => o.symbol === "USDT")!;
    expect(usdt.categories).toContain("stablecoins");
  });

  it("throws on API-level errors", () => {
    expect(() => parseCmcListings({ status: { error_code: 1008, error_message: "rate limit" }, data: [] })).toThrow(/1008/);
  });

  it("maps tags to categories", () => {
    expect(cmcCategories(["stablecoin", "wrapped-tokens"])).toEqual(["stablecoins", "wrapped-tokens"]);
  });
});

describe("CoinGecko parsers", () => {
  it("parses /coins/markets with provider change fields", () => {
    const r = parseCoinGeckoMarkets(fixture("coingecko-markets.json"));
    expect(r.rows).toBe(3);
    expect(r.skipped).toBe(1);
    const btc = r.observations[0]!;
    expect(btc.changePct1h).toBe(0.12);
    expect(btc.marketCap).toBe(1_980_000_000_000);
  });

  it("parses /coins/list platforms into chain + contract pairs and ignores empty ones", () => {
    const list = parseCoinGeckoList(fixture("coingecko-list.json"));
    expect(list.find((a) => a.providerAssetId === "usd-coin")!.platforms).toHaveLength(2);
    expect(list.find((a) => a.providerAssetId === "pepe-b")!.platforms).toEqual([{ chain: "base", contractAddress: "0x2222222222222222222222222222222222222222" }]);
    // Same symbol, different provider ids: two distinct identities.
    expect(list.filter((a) => a.symbol === "pepe").map((a) => a.providerAssetId)).toEqual(["pepe-a", "pepe-b"]);
  });
});

describe("observation validation", () => {
  it("keeps a complete, fresh observation", () => {
    const d = validateObservation(raw(), opts);
    expect(d.isStale).toBe(false);
    expect(d.completeness).toBe(1);
    expect(d.marketCapProvenance).toBe("provider_reported");
    expect(d.freshnessSeconds).toBe(240);
  });

  it("calculates market cap from circulating supply when missing and labels provenance", () => {
    const d = validateObservation(raw({ marketCap: 0 }), opts);
    expect(d.marketCap).toBe(2_000_000);
    expect(d.marketCapProvenance).toBe("calculated_from_circulating_supply");
    expect(d.qualityFlags).toContain("market_cap_calculated");
  });

  it("never substitutes fully diluted valuation for market cap", () => {
    const d = validateObservation(raw({ marketCap: null, circulatingSupply: null }), opts);
    expect(d.marketCap).toBeNull();
    expect(d.marketCapProvenance).toBe("unavailable");
    expect(d.fullyDilutedValuation).toBe(9_000_000);
    expect(d.nullReasons.marketCap).toMatch(/FDV is never substituted/);
  });

  it("keeps rolling 24h volume separate and never derives hourly volume", () => {
    const d = validateObservation(raw(), opts);
    expect(d.volumeRolling24h).toBe(500_000);
    expect(d.volumeHourly).toBeNull();
    expect(d.nullReasons.volumeHourly).toMatch(/not derived from differences/);
  });

  it("flags stale and unknown observation times", () => {
    expect(validateObservation(raw({ observedAt: new Date("2026-11-03T09:00:00Z") }), opts).isStale).toBe(true);
    const u = validateObservation(raw({ observedAt: null }), opts);
    expect(u.isStale).toBe(true);
    expect(u.qualityFlags).toContain("unknown_observation_time");
  });

  it("treats invalid prices as missing with a reason", () => {
    const d = validateObservation(raw({ price: -1 }), opts);
    expect(d.price).toBeNull();
    expect(d.nullReasons.price).toMatch(/invalid/);
  });

  it("sanitizes untrusted names and symbols", () => {
    expect(sanitizeText("Weird\u0007 Token ‮evil", 120)).toBe("Weird Token evil");
    expect(sanitizeText("x".repeat(500), 32)).toHaveLength(32);
  });

  it("normalizes EVM contracts case-insensitively but leaves other chains intact", () => {
    expect(normalizeContract("Ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48").contractAddress).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(normalizeContract("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").contractAddress).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });
});

describe("asset classification", () => {
  it("uses provider categories first", () => {
    expect(classifyAsset({ name: "Tether", symbol: "USDT", categories: ["stablecoins"] })).toMatchObject({ assetClass: "stablecoin", classSource: "provider_category" });
    expect(classifyAsset({ name: "WBTC", symbol: "WBTC", categories: ["wrapped-tokens"] }).assetClass).toBe("wrapped");
  });
  it("falls back to name heuristics", () => {
    expect(classifyAsset({ name: "Wrapped Bitcoin", symbol: "WBTC" })).toMatchObject({ assetClass: "wrapped", underlyingAsset: "bitcoin" });
    expect(classifyAsset({ name: "Lido Staked ETH", symbol: "STETH" }).assetClass).toBe("staked");
    expect(classifyAsset({ name: "Some Coin", symbol: "ABC" }).assetClass).toBe("regular");
  });
  it("never relaxes an exclusion on re-classification", () => {
    expect(stricterClass("regular", "stablecoin")).toBe(true);
    expect(stricterClass("stablecoin", "regular")).toBe(false);
  });
});

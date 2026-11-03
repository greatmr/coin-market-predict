import { describe, expect, it } from "vitest";
import { addHours, formatInZone, HOUR_MS, slotOf } from "../../src/common/time.js";
import { applyMarketContext, buildMarketContext, computeBaseFeatures, consecutiveDepth, type MarketContext, type SeriesPoint } from "../../src/features/compute.js";
import { FEATURES, STATISTICAL_WARMUP_SNAPSHOTS } from "../../src/features/registry.js";
import { buildScenario } from "../../src/screening/scenario.js";
import { rankAndShortlist, screenAsset, type ScreenInput } from "../../src/screening/screen.js";
import { defaultStrategy } from "../../src/screening/strategy.js";

const t0 = new Date("2026-11-03T12:00:00Z");
const opts = { snapshotWindow: 3, statisticalWarmup: STATISTICAL_WARMUP_SNAPSHOTS, paperNotionalUsd: 1000 };

function series(prices: Array<number | null>, vols?: number[], end = t0): SeriesPoint[] {
  return prices.map((p, i) => ({
    slotTime: addHours(end, i - prices.length + 1),
    price: p,
    marketCap: p === null ? null : p * 1e7,
    volumeRolling24h: vols?.[i] ?? 1e6,
    isStale: false,
    providerChangePct1h: null,
    providerChangePct24h: null,
    bidAskSpreadPct: null,
    depthPlus2PctUsd: null,
  }));
}

describe("time slots", () => {
  it("buckets to the UTC hour and formats in the display timezone", () => {
    expect(slotOf(new Date("2026-11-03T12:59:59.999Z")).toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(formatInZone(new Date("2026-11-03T12:00:00Z"), "Asia/Tehran")).toMatch(/^2026-11-03 15:30/);
  });
});

describe("feature computation", () => {
  it("computes t, t-1h, t-2h heuristics exactly", () => {
    const f = computeBaseFeatures(series([100, 102, 106.08], [1e6, 1.1e6, 1.5e6]), opts);
    expect(f.historyDepth).toBe(3);
    expect(f.warmupState).toBe("limited");
    expect(f.values.ret_1h).toBeCloseTo(0.04, 10);
    expect(f.values.ret_2h).toBeCloseTo(0.0608, 10);
    expect(f.values.accel_1h).toBeCloseTo(0.04 - 0.02, 10);
    expect(f.values.vol24_change_2h).toBeCloseTo(0.5, 10);
  });

  it("disables features with explicit warm-up reasons instead of fabricating them", () => {
    const f = computeBaseFeatures(series([100, 101]), opts);
    expect(f.warmupState).toBe("warming_up");
    expect(f.values.ret_2h).toBeNull();
    expect(f.unavailable.ret_2h).toMatch(/needs 3 consecutive hourly snapshots, have 2/);
    expect(f.values.realized_vol_24h).toBeNull();
    expect(f.unavailable.realized_vol_24h).toMatch(/needs 25/);
    expect(f.values.spread_pct).toBeNull();
  });

  it("breaks history at a missing hour: t-2 is never used as t-1", () => {
    const s = series([100, 101, 102]);
    s.splice(1, 1); // remove t-1
    expect(consecutiveDepth(s)).toBe(1);
    const f = computeBaseFeatures(s, opts);
    expect(f.values.ret_1h).toBeNull();
  });

  it("breaks history at a stale observation", () => {
    const s = series([100, 101, 102]);
    s[1]!.isStale = true;
    expect(consecutiveDepth(s)).toBe(1);
  });

  it("enables statistical features only after the warm-up", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 * (1 + 0.001 * Math.sin(i)));
    const f = computeBaseFeatures(series(prices), opts);
    expect(f.values.realized_vol_24h).not.toBeNull();
    expect(f.values.breakout_24h).not.toBeNull();
    expect(f.values.vol24_zscore_72h).toBeNull();
    expect(f.warmupState).toBe("limited");
  });

  it("applies relative strength against BTC, ETH and the market", () => {
    const own = computeBaseFeatures(series([100, 101, 105]), opts);
    const btc = computeBaseFeatures(series([100, 100.5, 101]), opts);
    const universe = [0.01, 0.0, 0.02, -0.01, 0.005].map((r) => computeBaseFeatures(series([100, 100, 100 * (1 + r)]), opts));
    const ctx = buildMarketContext({ btc, eth: null, universe });
    const f = applyMarketContext(own, ctx);
    expect(f.values.rs_btc_1h).toBeCloseTo(105 / 101 - 1 - (101 / 100.5 - 1), 10);
    expect(f.values.rs_eth_1h).toBeNull();
    expect(f.unavailable.rs_eth_1h).toMatch(/ETH/);
    expect(f.values.rs_market_2h).toBeCloseTo(0.05 - 0.005, 10);
  });

  it("documents data requirements for every feature", () => {
    for (const d of FEATURES) {
      expect(d.minSnapshots).toBeGreaterThanOrEqual(1);
      expect(d.requiredFields.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(10);
    }
  });
});

const p = defaultStrategy();
const market: MarketContext = { btcRet1h: 0.001, ethRet1h: 0.001, marketMedianRet1h: 0.001, marketMedianRet2h: 0.002, breadth: 50, advancingShare: 0.5 };

function input(prices: number[], vols: number[], over: Partial<ScreenInput> = {}): ScreenInput {
  const s = series(prices, vols);
  const fv = applyMarketContext(computeBaseFeatures(s, opts), market);
  return {
    assetId: over.assetId ?? "a",
    symbol: "A",
    name: "A",
    assetClass: "regular",
    isBenchmark: false,
    hasCurrentSnapshot: true,
    latest: { price: prices.at(-1)!, marketCap: 5e8, fullyDilutedValuation: 6e8, volumeRolling24h: vols.at(-1)!, isStale: false, completeness: 1, marketCapProvenance: "provider_reported", qualityFlags: [] },
    features: fv,
    ...over,
  };
}

describe("screening", () => {
  it("classifies an early volume-led acceleration as an advance candidate", () => {
    const o = screenAsset(input([1, 1.005, 1.025], [10e6, 12e6, 16e6]), market, p);
    expect(o.eligible).toBe(true);
    expect(o.classification).toBe("advance_candidate");
    expect(o.heuristicScore).toBeGreaterThan(0);
    expect(o.heuristicScore).toBeLessThanOrEqual(100);
  });

  it("separates a move already underway from an advance signal", () => {
    expect(screenAsset(input([1, 1.05, 1.12], [10e6, 15e6, 25e6]), market, p).classification).toBe("move_underway");
  });

  it("labels steady appreciation as a gradual trend, not a surge", () => {
    expect(screenAsset(input([1, 1.002, 1.004], [10e6, 10e6, 10e6]), market, p).classification).toBe("gradual_trend");
  });

  it("labels moves that only track a broad rally as market-wide", () => {
    const rally = { ...market, marketMedianRet2h: 0.04 };
    const i = input([1, 1.02, 1.045], [10e6, 12e6, 16e6]);
    i.features = applyMarketContext(i.features, rally);
    expect(screenAsset(i, rally, p).classification).toBe("market_wide");
  });

  it("labels very large moves as overextended", () => {
    expect(screenAsset(input([1, 1.15, 1.3], [10e6, 20e6, 40e6]), market, p).classification).toBe("overextended");
  });

  it("excludes stablecoins, wrapped, stale, illiquid, warming-up and benchmark assets with reasons", () => {
    const base = input([1, 1.005, 1.025], [10e6, 12e6, 16e6]);
    expect(screenAsset({ ...base, assetClass: "stablecoin" }, market, p).exclusionReasons).toContain("excluded_class:stablecoin");
    expect(screenAsset({ ...base, assetClass: "wrapped" }, market, p).eligible).toBe(false);
    expect(screenAsset({ ...base, latest: { ...base.latest!, isStale: true } }, market, p).exclusionReasons).toContain("stale_observation");
    expect(screenAsset({ ...base, latest: { ...base.latest!, volumeRolling24h: 1000 } }, market, p).exclusionReasons).toContain("illiquid_volume");
    expect(screenAsset({ ...base, isBenchmark: true }, market, p).exclusionReasons).toContain("benchmark_reference");
    expect(screenAsset(input([1, 1.01], [1e7, 1e7]), market, p).exclusionReasons).toContain("warming_up");
    expect(screenAsset({ ...base, hasCurrentSnapshot: false, latest: null }, market, p).exclusionReasons).toContain("no_current_snapshot");
  });

  it("flags manipulation-like volume and penalizes the score", () => {
    const clean = screenAsset(input([1, 1.005, 1.025], [10e6, 12e6, 16e6]), market, p);
    const wash = screenAsset(input([1, 1.005, 1.025], [10e6, 12e6, 16e6], { latest: { price: 1.025, marketCap: 1e7, fullyDilutedValuation: 1e8, volumeRolling24h: 16e6, isStale: false, completeness: 1, marketCapProvenance: "provider_reported", qualityFlags: [] } }), market, p);
    expect(wash.riskFlags).toContain("volume_exceeds_market_cap");
    expect(wash.riskFlags).toContain("large_fdv_overhang");
    expect(wash.heuristicScore).toBeLessThan(clean.heuristicScore);
  });

  it("shortlists eligible coins by strategy pump chance (high, or medium above the minimum score), ranked by score", () => {
    // Market cap is price × 1e7 here, so volumes stay below it (no manipulation-like flags).
    const outs = [
      { ...screenAsset(input([1, 1.005, 1.025], [1e6, 1.2e6, 1.6e6], { assetId: "a" }), market, p) },
      { ...screenAsset(input([1, 1.05, 1.12], [1e6, 1.5e6, 2.5e6], { assetId: "b" }), market, p) },
      { ...screenAsset(input([1, 1.002, 1.004], [1e6, 1e6, 1e6], { assetId: "c" }), market, p) },
    ];
    expect(outs.map((o) => [o.assetId, o.classification])).toEqual([["a", "advance_candidate"], ["b", "move_underway"], ["c", expect.not.stringMatching(/advance|underway/)]]);
    const ranked = rankAndShortlist(outs, 1, 0);
    expect(ranked.filter((r) => r.shortlisted).map((r) => r.assetId)).toEqual(["a"]);
    expect(ranked.find((r) => r.assetId === "c")!.pumpChance).toBe("low");
    expect(ranked.map((r) => r.rank).sort()).toEqual([1, 2, 3]);
    expect(rankAndShortlist(outs, 5, 0).filter((r) => r.shortlisted).every((r) => r.pumpChance !== "low")).toBe(true);
  });

  it("rules out a pump call when 24h volume exceeds market cap, even for an advance pattern", () => {
    const o = screenAsset(input([1, 1.005, 1.025], [10e6, 12e6, 16e6]), market, p);
    expect(o.classification).toBe("advance_candidate");
    expect(o.riskFlags).toContain("volume_exceeds_market_cap");
    expect(o.pumpChance).toBe("low");
    expect(o.pumpReasons[0]).toMatch(/ruled out: 24h volume above market cap/);
    expect(rankAndShortlist([o], 5, 0)[0]!.shortlisted).toBe(false);
  });

  it("builds a conditional paper scenario from strategy parameters", () => {
    const sc = buildScenario({ referencePrice: 100, slotTime: t0, classification: "advance_candidate", params: p, feeBps: 10, slippageBps: 30, estSlippagePct: null });
    expect(sc.entryTriggerPrice).toBeCloseTo(101, 8);
    expect(sc.stopPrice).toBeCloseTo(101 * 0.93, 8);
    expect(sc.targetPrice).toBeCloseTo(101 * 1.15, 8);
    expect(new Date(sc.signalExpiresAt).getTime() - t0.getTime()).toBe(6 * HOUR_MS);
    expect(sc.executionAssumption).toMatch(/Intrahour/);
  });
});

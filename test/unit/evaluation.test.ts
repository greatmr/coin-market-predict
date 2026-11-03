import { describe, expect, it } from "vitest";
import { addHours } from "../../src/common/time.js";
import { runBacktest, type BacktestAsset, type BacktestSnapshot } from "../../src/evaluation/backtest.js";
import { evaluateTarget } from "../../src/evaluation/outcome.js";
import { simulatePosition, type Observation, type ScenarioParams } from "../../src/evaluation/simulate.js";
import { FixtureMarket } from "../../src/sources/fixture/fixture-market.js";
import { defaultStrategy, RESEARCH_TARGET_V1 } from "../../src/screening/strategy.js";

const t0 = new Date("2026-11-03T00:00:00Z");
const obs = (prices: Array<number | null>, start = t0): Observation[] => prices.map((p, i) => ({ slotTime: addHours(start, i + 1), price: p }));
const params = (over: Partial<ScenarioParams> = {}): ScenarioParams => ({
  signalSlot: t0,
  entryTriggerPrice: 101,
  stopPct: 0.07,
  targetPct: 0.15,
  trailActivatePct: 0.08,
  trailPct: 0.05,
  maxHoldHours: 24,
  signalExpiresAt: addHours(t0, 6),
  feeBps: 10,
  slippageBps: 30,
  ...over,
});
const far = addHours(t0, 100);

describe("paper simulation", () => {
  it("expires when the entry trigger never prints before expiry", () => {
    const r = simulatePosition(params(), obs([100, 100.5, 100, 99, 100, 100.2, 105]), far);
    expect(r.status).toBe("expired");
    expect(r.exitReason).toBe("expired_no_entry");
  });

  it("enters at the observed price plus slippage and exits at the target (never better)", () => {
    const r = simulatePosition(params(), obs([102, 110, 130]), far);
    expect(r.entryPrice).toBeCloseTo(102 * 1.003, 8);
    expect(r.exitReason).toBe("target");
    expect(r.exitPrice).toBeCloseTo(r.targetPrice! * (1 - 0.003), 8);
    expect(r.netReturn).toBeCloseTo(r.grossReturn! - 0.002, 10);
  });

  it("exits a gap through the stop at the observed price, not the stop price", () => {
    const r = simulatePosition(params(), obs([102, 80]), far);
    expect(r.exitReason).toBe("stop");
    expect(r.exitPrice).toBeCloseTo(80 * 0.997, 8);
    expect(r.netReturn!).toBeLessThan(-0.2);
  });

  it("assumes the stop first when a bar contains both stop and target", () => {
    const o: Observation[] = [{ slotTime: addHours(t0, 1), price: 102 }, { slotTime: addHours(t0, 2), price: 110, high: 200, low: 50 }];
    const r = simulatePosition(params(), o, far);
    expect(r.ambiguousOrdering).toBe(true);
    expect(r.exitReason).toBe("stop");
  });

  it("applies the trailing stop and maximum holding period", () => {
    expect(simulatePosition(params(), obs([102, 111, 104]), far).exitReason).toBe("trailing_stop");
    const flat = simulatePosition(params({ maxHoldHours: 3 }), obs([102, 102, 102, 102, 102]), far);
    expect(flat.exitReason).toBe("max_hold");
  });

  it("uses no look-ahead: ignores observations at or before the signal and after asOf", () => {
    const o = [{ slotTime: t0, price: 200 }, ...obs([100, 100])];
    const r = simulatePosition(params(), o, addHours(t0, 2));
    expect(r.status).toBe("pending_entry");
    const later = simulatePosition(params(), [...obs([100, 100]), { slotTime: addHours(t0, 50), price: 500 }], addHours(t0, 3));
    expect(later.entryAt).toBeNull();
  });

  it("closes on a data gap (possible delisting) at the last usable observation", () => {
    const o: Observation[] = [{ slotTime: addHours(t0, 1), price: 102 }, { slotTime: addHours(t0, 2), price: 103 }, { slotTime: addHours(t0, 7), price: null }];
    const r = simulatePosition(params(), o, far);
    expect(r.exitReason).toBe("data_gap");
  });
});

describe("research target labeling", () => {
  it("requires the return threshold, benchmark excess, and no prior adverse breach", () => {
    expect(evaluateTarget(RESEARCH_TARGET_V1, t0, 100, obs([105, 116]), 0.01, far).status).toBe("hit");
    expect(evaluateTarget(RESEARCH_TARGET_V1, t0, 100, obs([105, 116, ...Array(22).fill(110)]), 0.1, far).status).toBe("miss");
    expect(evaluateTarget(RESEARCH_TARGET_V1, t0, 100, obs([105, 116]), 0.1, far).status).toBe("insufficient_data");
    expect(evaluateTarget(RESEARCH_TARGET_V1, t0, 100, obs([92, 116, ...Array(20).fill(110)]), 0.0, far).status).toBe("miss");
  });
  it("stays pending before the horizon and refuses to label without a benchmark", () => {
    expect(evaluateTarget(RESEARCH_TARGET_V1, t0, 100, obs([101]), null, addHours(t0, 2)).status).toBe("pending");
    expect(evaluateTarget(RESEARCH_TARGET_V1, t0, 100, obs(Array(24).fill(101)), null, far).status).toBe("insufficient_data");
  });
});

function fixtureSeries(hours: number) {
  const anchor = new Date("2026-11-03T12:00:00Z");
  const m = new FixtureMarket(anchor);
  const assets: BacktestAsset[] = FixtureMarket.specs().map((s) => ({
    id: s.id,
    symbol: s.symbol,
    name: s.name,
    assetClass: s.scenario === "stablecoin" ? "stablecoin" : s.scenario === "wrapped" ? "wrapped" : "regular",
    isBenchmark: s.scenario === "benchmark",
  }));
  const series = new Map<string, BacktestSnapshot[]>();
  for (let h = hours; h >= 0; h--) {
    const slot = addHours(anchor, -h);
    for (const o of m.observationsFor(slot)) {
      const list = series.get(o.providerAssetId) ?? [];
      list.push({
        slotTime: slot,
        price: o.price,
        marketCap: o.marketCap,
        fullyDilutedValuation: o.fullyDilutedValuation,
        volumeRolling24h: o.volume24h,
        isStale: o.observedAt!.getTime() < slot.getTime() - 3600_000,
        providerChangePct1h: o.changePct1h ?? null,
        providerChangePct24h: o.changePct24h ?? null,
        bidAskSpreadPct: null,
        depthPlus2PctUsd: null,
        completeness: 1,
        marketCapProvenance: "provider_reported",
        qualityFlags: [],
      });
      series.set(o.providerAssetId, list);
    }
  }
  return { assets, series };
}

const btOpts = { shortlistSize: 3, snapshotWindow: 3, feeBps: 10, slippageBps: 30, minHistoryHours: 168, finalTestFraction: 0.2, includeFinalTest: false, foldHours: 72 };

describe("walk-forward backtest", () => {
  it("reports pending instead of inventing results when history is insufficient", () => {
    const { assets, series } = fixtureSeries(48);
    const r = runBacktest(assets, series, defaultStrategy(), btOpts);
    expect(r.status).toBe("pending_insufficient_history");
    expect(r.reason).toMatch(/need at least 192h/);
    expect(r.strategy).toBeUndefined();
  });

  it("evaluates with baselines, keeps the final test untouched, and does not report calibration", () => {
    const { assets, series } = fixtureSeries(260);
    const r = runBacktest(assets, series, defaultStrategy(), btOpts);
    expect(r.status).toBe("completed");
    expect(r.finalTest).toBeNull();
    expect(r.finalTestPeriod?.evaluated).toBe(false);
    expect(r.momentumBaseline).toBeDefined();
    expect(r.btcBuyHold!.windows).toBeGreaterThan(0);
    expect(r.calibration).toMatch(/Not applicable/);
    expect(new Date(r.developmentPeriod!.end) < new Date(r.finalTestPeriod!.start)).toBe(true);
  });

  it("has no look-ahead: changing prices after the evaluation period does not change signals", () => {
    const a = fixtureSeries(260);
    const b = fixtureSeries(260);
    const ra = runBacktest(a.assets, a.series, defaultStrategy(), btOpts);
    // Perturb only the final-test segment (after every development signal slot + horizon).
    const cut = new Date(ra.finalTestPeriod!.start).getTime() + 30 * 3600_000;
    for (const s of b.series.values()) for (const p of s) if (p.slotTime.getTime() > cut && p.price) p.price *= 3;
    const rb = runBacktest(b.assets, b.series, defaultStrategy(), btOpts);
    expect(rb.strategy!.signals).toBe(ra.strategy!.signals);
    expect(rb.momentumBaseline!.signals).toBe(ra.momentumBaseline!.signals);
  });
});

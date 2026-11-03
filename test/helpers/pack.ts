import type { EvidencePack } from "../../src/screening/evidence.js";
import { buildScenario } from "../../src/screening/scenario.js";
import { defaultStrategy } from "../../src/screening/strategy.js";

export const ASSET_ID = "11111111-1111-4111-8111-111111111111";
export const SLOT = new Date("2026-11-03T12:00:00Z");
export const OBSERVED = "2026-11-03T12:03:00.000Z";

export function makePack(over: Partial<EvidencePack> = {}): EvidencePack {
  const strategy = defaultStrategy();
  return {
    assetId: ASSET_ID,
    identity: { name: "Test Coin", symbol: "TST", provider: "fixture", providerAssetId: "fx-test", contracts: [], assetClass: "regular" },
    source: { url: "fixture://coins/fx-test", provider: "fixture", isLive: false, attribution: null },
    latest: {
      slotTime: SLOT.toISOString(),
      observedAt: OBSERVED,
      collectedAt: "2026-11-03T12:07:00.000Z",
      freshnessSeconds: 240,
      priceUsd: 1.025,
      marketCapUsd: 5e8,
      marketCapProvenance: "provider_reported",
      volume24hUsd: 1.6e7,
      volumeWindow: "rolling_24h",
      hourlyVolumeUsd: null,
      circulatingSupply: 4.9e8,
      qualityFlags: [],
      completeness: 1,
      nullReasons: { volumeHourly: "rolling only" },
    },
    recentSnapshots: [
      { slotTime: SLOT.toISOString(), observedAt: OBSERVED, priceUsd: 1.025, volume24hUsd: 1.6e7, isStale: false },
      { slotTime: "2026-11-03T11:00:00.000Z", observedAt: "2026-11-03T11:03:00.000Z", priceUsd: 1.005, volume24hUsd: 1.2e7, isStale: false },
    ],
    features: { ret_1h: 0.0199, ret_2h: 0.025, accel_1h: 0.0149, vol24_change_2h: 0.6, rs_market_2h: 0.023, vol_mcap: 0.032 },
    unavailableFeatures: { spread_pct: "source does not provide spread" },
    historyDepth: 30,
    warmupState: "limited",
    screening: { classification: "advance_candidate", heuristicScore: 61.5, components: {}, riskFlags: ["no_liquidity_data"], rank: 1 },
    market: { btcRet1h: 0.001, ethRet1h: 0.001, marketMedianRet1h: 0.001, marketMedianRet2h: 0.002, breadth: 20, advancingShare: 0.5 },
    scenario: buildScenario({ referencePrice: 1.025, slotTime: SLOT, classification: "advance_candidate", params: strategy, feeBps: 10, slippageBps: 30, estSlippagePct: null }),
    strategyVersion: strategy.version,
    featureSetVersion: "fs-1",
    ...over,
  };
}

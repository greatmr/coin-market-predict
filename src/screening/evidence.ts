import { createHash } from "node:crypto";
import type { MarketContext } from "../features/compute.js";
import type { ThreeDay, VmcContext } from "./context.js";
import type { PumpChance } from "./recommend.js";
import type { PaperScenario } from "./scenario.js";
import type { ScreenOutput } from "./screen.js";

/**
 * Everything an agent may cite about one shortlisted asset. Built by code from the database;
 * agents receive it via tools and must not use outside information.
 */
export interface EvidencePack {
  assetId: string;
  identity: {
    name: string;
    symbol: string;
    provider: string;
    providerAssetId: string;
    contracts: Array<{ chain: string; contractAddress: string }>;
    assetClass: string;
  };
  source: { url: string; provider: string; isLive: boolean; attribution: string | null };
  latest: {
    slotTime: string;
    observedAt: string | null;
    collectedAt: string;
    freshnessSeconds: number | null;
    priceUsd: number | null;
    marketCapUsd: number | null;
    marketCapProvenance: string;
    volume24hUsd: number | null;
    volumeWindow: "rolling_24h";
    hourlyVolumeUsd: null | number;
    circulatingSupply: number | null;
    qualityFlags: string[];
    completeness: number;
    nullReasons: Record<string, string>;
  };
  recentSnapshots: Array<{ slotTime: string; observedAt: string | null; priceUsd: number | null; volume24hUsd: number | null; isStale: boolean }>;
  features: Record<string, number | null>;
  unavailableFeatures: Record<string, string>;
  historyDepth: number;
  warmupState: string;
  screening: Pick<ScreenOutput, "classification" | "heuristicScore" | "components" | "riskFlags"> & { rank: number | null };
  market: MarketContext;
  scenario: PaperScenario;
  /** Base-strategy pump chance (heuristic level, not a probability) with its reasons. */
  pump: { chance: PumpChance; reasons: string[] };
  /** Last three days of stored hourly prices and volume / market cap vs the six-month baseline. */
  context: { threeDay: ThreeDay; vmc: VmcContext | null };
  strategyVersion: string;
  featureSetVersion: string;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

const round = (x: number | null, digits = 3) => (x === null ? null : Number(x.toFixed(digits)));

/**
 * Coarse fingerprint of the analysis-relevant evidence. Two packs with the same fingerprint
 * would receive the same analysis, so the agent result can be reused instead of re-spending.
 */
export function evidenceFingerprint(p: EvidencePack): string {
  const features: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(p.features)) features[k] = round(v, 2);
  const payload = {
    assetId: p.assetId,
    classification: p.screening.classification,
    riskFlags: [...p.screening.riskFlags].sort(),
    warmupState: p.warmupState,
    features,
    quality: [...p.latest.qualityFlags].sort(),
    strategy: p.strategyVersion,
    featureSet: p.featureSetVersion,
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 32);
}

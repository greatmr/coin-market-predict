import { HOUR_MS, slotOf } from "../../common/time.js";
import type { RawObservation, SourceAsset } from "../types.js";

/**
 * Deterministic SYNTHETIC market used for offline development, demos, and tests.
 * Nothing here is real market data. Every asset id is prefixed "fx-" and the provider is
 * registered with isLive=false so dashboards and reports label it as fixture data.
 *
 * Scenarios are positioned relative to an anchor slot so the interesting behaviour
 * (surges, gradual trends, manipulation-like patterns) appears in the most recent hours.
 */

type Scenario =
  | "benchmark"
  | "stablecoin"
  | "wrapped"
  | "steady_trend" // gradual appreciation (the "Apple-like" steady climb)
  | "early_spark" // volume builds, price starting to accelerate (advance-signal shape)
  | "surge_underway" // sharp move already in progress
  | "wash_pump" // overextended pump with volume far above market cap
  | "illiquid"
  | "stale"
  | "missing_cap"
  | "gap"
  | "random";

interface FixtureAssetSpec {
  id: string;
  name: string;
  symbol: string;
  scenario: Scenario;
  price0: number;
  supply: number | null;
  maxSupply: number | null;
  baseVolume: number;
  volPerHour: number;
  beta: number;
  platforms?: Array<{ chain: string; contractAddress: string }>;
  categories?: string[];
}

const SPECS: FixtureAssetSpec[] = [
  { id: "fx-bitcoin", name: "Bitcoin (fixture)", symbol: "BTC", scenario: "benchmark", price0: 100_000, supply: 19_800_000, maxSupply: 21_000_000, baseVolume: 30e9, volPerHour: 0.004, beta: 1 },
  { id: "fx-ethereum", name: "Ethereum (fixture)", symbol: "ETH", scenario: "benchmark", price0: 3_500, supply: 120_000_000, maxSupply: null, baseVolume: 15e9, volPerHour: 0.005, beta: 1.1 },
  { id: "fx-tether", name: "Tether (fixture)", symbol: "USDT", scenario: "stablecoin", price0: 1, supply: 150e9, maxSupply: null, baseVolume: 60e9, volPerHour: 0.0003, beta: 0, categories: ["stablecoins"], platforms: [{ chain: "ethereum", contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }] },
  { id: "fx-usd-coin", name: "USD Coin (fixture)", symbol: "USDC", scenario: "stablecoin", price0: 1, supply: 60e9, maxSupply: null, baseVolume: 8e9, volPerHour: 0.0002, beta: 0, categories: ["stablecoins"] },
  { id: "fx-wrapped-bitcoin", name: "Wrapped Bitcoin (fixture)", symbol: "WBTC", scenario: "wrapped", price0: 100_000, supply: 130_000, maxSupply: null, baseVolume: 300e6, volPerHour: 0.004, beta: 1, categories: ["wrapped-tokens"], platforms: [{ chain: "ethereum", contractAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" }] },
  { id: "fx-steady-climb", name: "Steady Climb (fixture)", symbol: "STDY", scenario: "steady_trend", price0: 12, supply: 400e6, maxSupply: 500e6, baseVolume: 40e6, volPerHour: 0.002, beta: 0.6 },
  { id: "fx-early-spark", name: "Early Spark (fixture)", symbol: "SPRK", scenario: "early_spark", price0: 0.8, supply: 900e6, maxSupply: 1e9, baseVolume: 6e6, volPerHour: 0.008, beta: 0.9 },
  { id: "fx-surge-protocol", name: "Surge Protocol (fixture)", symbol: "SRG", scenario: "surge_underway", price0: 2.4, supply: 300e6, maxSupply: 1e9, baseVolume: 9e6, volPerHour: 0.009, beta: 1.2 },
  { id: "fx-moon-wash", name: "Moon Wash (fixture)", symbol: "WASH", scenario: "wash_pump", price0: 0.05, supply: 2e9, maxSupply: 10e9, baseVolume: 30e6, volPerHour: 0.015, beta: 1.5 },
  { id: "fx-tiny-cap", name: "Tiny Cap (fixture)", symbol: "TINY", scenario: "illiquid", price0: 0.002, supply: 1e9, maxSupply: 1e9, baseVolume: 15_000, volPerHour: 0.02, beta: 1 },
  { id: "fx-stale-coin", name: "Stale Coin (fixture)", symbol: "STAL", scenario: "stale", price0: 4, supply: 50e6, maxSupply: 50e6, baseVolume: 3e6, volPerHour: 0.006, beta: 1 },
  { id: "fx-missing-cap", name: "Missing Cap (fixture)", symbol: "NOCAP", scenario: "missing_cap", price0: 1.5, supply: null, maxSupply: 1e9, baseVolume: 4e6, volPerHour: 0.007, beta: 1 },
  { id: "fx-gap-token", name: "Gap Token (fixture)", symbol: "GAP", scenario: "gap", price0: 7, supply: 80e6, maxSupply: 100e6, baseVolume: 5e6, volPerHour: 0.006, beta: 1 },
  // Two different assets that share a ticker: identity must come from provider id + contract.
  { id: "fx-frog-one", name: "Frog One (fixture)", symbol: "FROG", scenario: "random", price0: 0.00001, supply: 400e12, maxSupply: 420e12, baseVolume: 50e6, volPerHour: 0.012, beta: 1.3, platforms: [{ chain: "ethereum", contractAddress: "0x1111111111111111111111111111111111111111" }] },
  { id: "fx-frog-two", name: "Frog Two (fixture)", symbol: "FROG", scenario: "random", price0: 0.003, supply: 1e9, maxSupply: 1e9, baseVolume: 2e6, volPerHour: 0.012, beta: 1.3, platforms: [{ chain: "solana", contractAddress: "FrogTwo1111111111111111111111111111111111111" }] },
];

const RANDOM_NAMES = ["Alpha", "Beacon", "Cobalt", "Delta", "Ember", "Flux", "Granite", "Harbor", "Ion", "Juniper", "Kestrel", "Lumen", "Meridian", "Nimbus", "Orbit"];
RANDOM_NAMES.forEach((n, i) => {
  SPECS.push({
    id: `fx-${n.toLowerCase()}`,
    name: `${n} (fixture)`,
    symbol: n.slice(0, 4).toUpperCase(),
    scenario: "random",
    price0: 0.5 + i * 1.7,
    supply: (50 + i * 30) * 1e6,
    maxSupply: (100 + i * 40) * 1e6,
    baseVolume: (2 + i) * 1e6,
    volPerHour: 0.005 + (i % 5) * 0.002,
    beta: 0.7 + (i % 4) * 0.2,
  });
});

/** mulberry32 PRNG: deterministic per (seed, stream). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function gaussian(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface PathPoint {
  price: number;
  hourlyVolume: number;
}

export const FIXTURE_HISTORY_HOURS = 24 * 30;

export class FixtureMarket {
  private readonly startSlotMs: number;
  private readonly cache = new Map<string, PathPoint[]>();
  private marketPath: number[] = [];

  constructor(
    private readonly anchorSlot: Date,
    private readonly seed = 42,
  ) {
    this.startSlotMs = slotOf(anchorSlot).getTime() - FIXTURE_HISTORY_HOURS * HOUR_MS;
  }

  static specs(): readonly FixtureAssetSpec[] {
    return SPECS;
  }

  listing(): SourceAsset[] {
    return SPECS.map((s) => ({
      providerAssetId: s.id,
      name: s.name,
      symbol: s.symbol,
      sourceUrl: `fixture://coins/${s.id}`,
      platforms: s.platforms ?? [],
      categories: s.categories ?? [],
    }));
  }

  /** Hours since the anchor (0 = anchor slot, negative = before). */
  private offsetOf(index: number): number {
    return index - FIXTURE_HISTORY_HOURS;
  }

  private ensureMarket(n: number) {
    if (this.marketPath.length >= n) return;
    const r = prng(this.seed);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(gaussian(r) * 0.003 + 0.00005);
    this.marketPath = out;
  }

  private path(spec: FixtureAssetSpec, untilIndex: number): PathPoint[] {
    const cached = this.cache.get(spec.id);
    if (cached && cached.length > untilIndex) return cached;
    const n = untilIndex + 1;
    this.ensureMarket(n);
    const r = prng(this.seed ^ hash(spec.id));
    const out: PathPoint[] = [];
    let logPrice = Math.log(spec.price0);
    for (let i = 0; i < n; i++) {
      const off = this.offsetOf(i);
      const mkt = this.marketPath[i] ?? 0;
      let drift = 0;
      let volMult = 1;
      let noise = gaussian(r) * spec.volPerHour;
      switch (spec.scenario) {
        case "stablecoin":
          logPrice = Math.log(1 + gaussian(r) * 0.0004);
          out.push({ price: Math.exp(logPrice), hourlyVolume: (spec.baseVolume / 24) * (1 + gaussian(r) * 0.05) });
          continue;
        case "steady_trend":
          drift = 0.0025; // ~0.25%/h, persistent, low volatility
          noise *= 0.5;
          break;
        case "early_spark":
          if (off >= -3 && off <= 0) {
            volMult = [1.8, 2.6, 3.6, 4.8][off + 3] ?? 1;
            drift = [0.003, 0.006, 0.011, 0.018][off + 3] ?? 0;
            noise *= 0.3;
          }
          break;
        case "surge_underway":
          if (off >= -2 && off <= 0) {
            volMult = [3, 5, 7][off + 2] ?? 1;
            drift = [0.03, 0.055, 0.08][off + 2] ?? 0;
            noise *= 0.3;
          }
          break;
        case "wash_pump":
          volMult = 6;
          if (off >= -12 && off <= 0) drift = 0.05;
          break;
        default:
          break;
      }
      logPrice += drift + spec.beta * mkt + noise;
      const vol = (spec.baseVolume / 24) * volMult * Math.exp(gaussian(r) * 0.15);
      out.push({ price: Math.exp(logPrice), hourlyVolume: vol });
    }
    this.cache.set(spec.id, out);
    return out;
  }

  /** Observation for every listed asset at `slot`, as the fixture "source" would report it. */
  observationsFor(slot: Date): RawObservation[] {
    const idx = Math.round((slotOf(slot).getTime() - this.startSlotMs) / HOUR_MS);
    if (idx < 24) return [];
    const result: RawObservation[] = [];
    for (const spec of SPECS) {
      if (spec.scenario === "gap" && this.offsetOf(idx) === -1) continue; // missing observation
      const p = this.path(spec, idx);
      const cur = p[idx]!;
      const vol24 = p.slice(idx - 23, idx + 1).reduce((s, x) => s + x.hourlyVolume, 0);
      const back = (h: number) => p[idx - h]?.price ?? null;
      const pct = (h: number) => {
        const b = back(h);
        return b ? (cur.price / b - 1) * 100 : null;
      };
      const observedAt =
        spec.scenario === "stale"
          ? new Date(slot.getTime() - 5 * HOUR_MS)
          : new Date(slotOf(slot).getTime() + 3 * 60_000);
      const supply = spec.supply;
      result.push({
        providerAssetId: spec.id,
        name: spec.name,
        symbol: spec.symbol,
        sourceUrl: `fixture://coins/${spec.id}`,
        observedAt,
        price: cur.price,
        marketCap: supply === null ? null : cur.price * supply,
        fullyDilutedValuation: spec.maxSupply ? cur.price * spec.maxSupply : null,
        circulatingSupply: supply,
        volume24h: vol24,
        volumeHourly: null,
        changePct1h: pct(1),
        changePct24h: pct(24),
        changePct7d: pct(168),
      });
    }
    return result;
  }
}

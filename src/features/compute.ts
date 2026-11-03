import { HOUR_MS } from "../common/time.js";
import { FEATURES } from "./registry.js";

/** One hourly point of an asset's series (already validated). */
export interface SeriesPoint {
  slotTime: Date;
  price: number | null;
  marketCap: number | null;
  volumeRolling24h: number | null;
  isStale: boolean;
  providerChangePct1h: number | null;
  providerChangePct24h: number | null;
  bidAskSpreadPct: number | null;
  depthPlus2PctUsd: number | null;
}

export interface MarketContext {
  btcRet1h: number | null;
  ethRet1h: number | null;
  marketMedianRet1h: number | null;
  marketMedianRet2h: number | null;
  /** Assets contributing to the market median. */
  breadth: number;
  /** Share of contributing assets with positive ret_2h. */
  advancingShare: number | null;
}

export type WarmupState = "warming_up" | "limited" | "full";

export interface FeatureVector {
  values: Record<string, number | null>;
  unavailable: Record<string, string>;
  historyDepth: number;
  warmupState: WarmupState;
}

export interface ComputeOptions {
  /** Minimum snapshots for the "limited" heuristic state (the configured t, t-1, t-2 window). */
  snapshotWindow: number;
  statisticalWarmup: number;
  paperNotionalUsd: number;
}

/**
 * Consecutive usable hourly points ending at the last element. A point is usable when it is
 * not stale and has a price. A missing hour breaks the chain: t-2 is never used as t-1.
 */
export function consecutiveDepth(seriesAsc: SeriesPoint[]): number {
  let depth = 0;
  for (let i = seriesAsc.length - 1; i >= 0; i--) {
    const p = seriesAsc[i]!;
    if (p.isStale || p.price === null) break;
    if (i < seriesAsc.length - 1) {
      const next = seriesAsc[i + 1]!;
      if (next.slotTime.getTime() - p.slotTime.getTime() !== HOUR_MS) break;
    }
    depth++;
  }
  return depth;
}

const ret = (a: number, b: number) => a / b - 1;

function std(xs: number[]): number {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Asset-local features (everything that does not need cross-asset context). */
export function computeBaseFeatures(seriesAsc: SeriesPoint[], opts: ComputeOptions): FeatureVector {
  const depth = consecutiveDepth(seriesAsc);
  const usable = seriesAsc.slice(seriesAsc.length - depth);
  const values: Record<string, number | null> = {};
  const unavailable: Record<string, string> = {};
  const last = usable[usable.length - 1];
  const at = (k: number) => usable[usable.length - 1 - k]; // k hours back

  const set = (name: string, fn: () => number | null, missingFieldReason?: string) => {
    const def = FEATURES.find((f) => f.name === name)!;
    if (depth < def.minSnapshots) {
      values[name] = null;
      unavailable[name] = `warm-up: needs ${def.minSnapshots} consecutive hourly snapshots, have ${depth}`;
      return;
    }
    const v = fn();
    if (v === null || !Number.isFinite(v)) {
      values[name] = null;
      unavailable[name] = missingFieldReason ?? `required fields unavailable: ${def.requiredFields.join(", ")}`;
      return;
    }
    values[name] = v;
  };

  set("ret_1h", () => ret(at(0)!.price!, at(1)!.price!));
  set("ret_2h", () => ret(at(0)!.price!, at(2)!.price!));
  set("accel_1h", () => ret(at(0)!.price!, at(1)!.price!) - ret(at(1)!.price!, at(2)!.price!));
  set("vol24_change_2h", () => {
    const a = at(0)!.volumeRolling24h;
    const b = at(2)!.volumeRolling24h;
    return a !== null && b !== null && b > 0 ? ret(a, b) : null;
  });
  set("vol_mcap", () => {
    if (!last || last.volumeRolling24h === null || last.marketCap === null || last.marketCap <= 0) return null;
    return last.volumeRolling24h / last.marketCap;
  }, "rolling 24h volume or circulating market cap unavailable");
  set("provider_change_24h", () => (last?.providerChangePct24h ?? null) === null ? null : last!.providerChangePct24h! / 100);
  set("provider_change_1h_gap", () => {
    const pc = at(0)!.providerChangePct1h;
    return pc === null ? null : Math.abs(ret(at(0)!.price!, at(1)!.price!) - pc / 100);
  });

  const hourlyLogReturns = (n: number) => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(Math.log(at(k)!.price! / at(k + 1)!.price!));
    return out;
  };
  set("trend_persistence_12h", () => hourlyLogReturns(12).filter((r) => r > 0).length / 12);
  set("realized_vol_24h", () => std(hourlyLogReturns(24)));
  set("ret_zscore_1h", () => {
    const rv = std(hourlyLogReturns(24));
    return rv > 0 ? Math.log(at(0)!.price! / at(1)!.price!) / rv : null;
  });
  set("breakout_24h", () => {
    let max = 0;
    for (let k = 1; k <= 24; k++) max = Math.max(max, at(k)!.price!);
    return max > 0 ? ret(at(0)!.price!, max) : null;
  });
  set("vol24_zscore_72h", () => {
    const xs: number[] = [];
    for (let k = 1; k <= 72; k++) {
      const v = at(k)!.volumeRolling24h;
      if (v === null || v <= 0) return null;
      xs.push(Math.log(v));
    }
    const cur = at(0)!.volumeRolling24h;
    if (cur === null || cur <= 0) return null;
    const s = std(xs);
    return s > 0 ? (Math.log(cur) - xs.reduce((a, b) => a + b, 0) / xs.length) / s : null;
  });
  set("spread_pct", () => last?.bidAskSpreadPct ?? null, "source does not provide bid/ask spread for this asset");
  set(
    "est_slippage_pct",
    () => {
      const depthUsd = last?.depthPlus2PctUsd;
      if (!depthUsd || depthUsd <= 0) return null;
      return Math.min(0.5, (0.02 * opts.paperNotionalUsd) / depthUsd);
    },
    "source does not provide order-book depth for this asset",
  );

  // Cross-asset features are filled in by applyMarketContext.
  for (const f of FEATURES.filter((d) => d.needsMarketContext)) {
    values[f.name] = null;
    unavailable[f.name] = "market context not applied";
  }

  const warmupState: WarmupState = depth < opts.snapshotWindow ? "warming_up" : depth < opts.statisticalWarmup ? "limited" : "full";
  return { values, unavailable, historyDepth: depth, warmupState };
}

export function applyMarketContext(fv: FeatureVector, ctx: MarketContext): FeatureVector {
  const values = { ...fv.values };
  const unavailable = { ...fv.unavailable };
  const r1 = fv.values.ret_1h ?? null;
  const r2 = fv.values.ret_2h ?? null;
  const rel = (name: string, own: number | null, bench: number | null, benchLabel: string) => {
    if (own === null) {
      values[name] = null;
      unavailable[name] = fv.unavailable[name.startsWith("rs_market_2h") ? "ret_2h" : "ret_1h"] ?? "own return unavailable";
    } else if (bench === null) {
      values[name] = null;
      unavailable[name] = `${benchLabel} return unavailable for this slot`;
    } else {
      values[name] = own - bench;
      delete unavailable[name];
    }
  };
  rel("rs_btc_1h", r1, ctx.btcRet1h, "BTC");
  rel("rs_eth_1h", r1, ctx.ethRet1h, "ETH");
  rel("rs_market_2h", r2, ctx.marketMedianRet2h, "market median");
  return { ...fv, values, unavailable };
}

export function buildMarketContext(input: {
  btc: FeatureVector | null;
  eth: FeatureVector | null;
  universe: FeatureVector[];
}): MarketContext {
  const r1 = input.universe.map((f) => f.values.ret_1h).filter((v): v is number => v !== null && v !== undefined);
  const r2 = input.universe.map((f) => f.values.ret_2h).filter((v): v is number => v !== null && v !== undefined);
  return {
    btcRet1h: input.btc?.values.ret_1h ?? null,
    ethRet1h: input.eth?.values.ret_1h ?? null,
    marketMedianRet1h: median(r1),
    marketMedianRet2h: r2.length >= 5 ? median(r2) : null,
    breadth: r2.length,
    advancingShare: r2.length ? r2.filter((x) => x > 0).length / r2.length : null,
  };
}

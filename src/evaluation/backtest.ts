import { HOUR_MS } from "../common/time.js";
import { applyMarketContext, buildMarketContext, computeBaseFeatures, median, type FeatureVector, type SeriesPoint } from "../features/compute.js";
import { STATISTICAL_WARMUP_SNAPSHOTS } from "../features/registry.js";
import { rankAndShortlist, screenAsset, SHORTLIST_CLASSES, type ScreenInput } from "../screening/screen.js";
import type { StrategyParams } from "../screening/strategy.js";
import { evaluateTarget } from "./outcome.js";
import { simulatePosition, type SimResult } from "./simulate.js";

export interface BacktestSnapshot extends SeriesPoint {
  fullyDilutedValuation: number | null;
  completeness: number;
  marketCapProvenance: string;
  qualityFlags: string[];
}

export interface BacktestAsset {
  id: string;
  symbol: string;
  name: string;
  assetClass: string;
  isBenchmark: boolean;
}

export interface BacktestOptions {
  shortlistSize: number;
  snapshotWindow: number;
  feeBps: number;
  slippageBps: number;
  minHistoryHours: number;
  finalTestFraction: number;
  includeFinalTest: boolean;
  foldHours: number;
}

export interface StrategyMetrics {
  signals: number;
  trades: number;
  targetHits: number;
  precision: number | null;
  falsePositiveRate: number | null;
  recall: number | null;
  avgNetReturn: number | null;
  totalNetReturn: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  ambiguousOrdering: number;
}

export interface BacktestReportData {
  status: "pending_insufficient_history" | "completed";
  reason?: string;
  historyHours: number;
  requiredHours: number;
  periodStart: string | null;
  periodEnd: string | null;
  developmentPeriod?: { start: string; end: string };
  finalTestPeriod?: { start: string; end: string; evaluated: boolean };
  folds?: Array<{ start: string; end: string; strategy: StrategyMetrics; momentum: StrategyMetrics }>;
  strategy?: StrategyMetrics;
  momentumBaseline?: StrategyMetrics;
  btcBuyHold?: { avgReturnPerWindow: number | null; windows: number };
  marketMedian?: { avgReturnPerWindow: number | null; windows: number };
  finalTest?: { strategy: StrategyMetrics; momentum: StrategyMetrics } | null;
  calibration: string;
  assumptions: string[];
}

const EXCLUDED_MARKET = new Set(["stablecoin", "wrapped", "bridged", "staked"]);

interface Pick {
  assetId: string;
  slot: Date;
  sim: SimResult;
  hit: boolean;
}

/**
 * Time-ordered walk-forward evaluation. At each slot t only data with slotTime ≤ t is used to
 * compute features and eligibility; future observations are used only to label outcomes and
 * simulate exits. An asset is eligible at t only if it has an observation at t (point-in-time
 * universe; delisted assets drop out and open trades close on data gaps).
 */
export function runBacktest(
  assets: BacktestAsset[],
  series: Map<string, BacktestSnapshot[]>,
  params: StrategyParams,
  opts: BacktestOptions,
): BacktestReportData {
  const allSlots = [...new Set([...series.values()].flatMap((s) => s.map((p) => p.slotTime.getTime())))].sort((a, b) => a - b);
  const H = params.target.horizonHours;
  const requiredHours = opts.minHistoryHours + H;
  const historyHours = allSlots.length ? (allSlots[allSlots.length - 1]! - allSlots[0]!) / HOUR_MS + 1 : 0;
  const assumptions = [
    `Fees ${opts.feeBps} bps per side, slippage ${opts.slippageBps} bps per side (flat; no order-book depth).`,
    "Entries/exits evaluated only at hourly snapshots; intrahour highs/lows unobserved; stop assumed before target when ambiguous.",
    "One open simulated position per asset at a time; equal notional per trade; no leverage; no real orders.",
    "Agent review is NOT replayed in backtests: this evaluates the deterministic screen only.",
    "Asset classes (stablecoin/wrapped) use current classification, not point-in-time classification.",
  ];
  const calibration = "Not applicable: the system produces heuristic scores, not probabilities.";
  if (historyHours < requiredHours) {
    return {
      status: "pending_insufficient_history",
      reason: `Have ${historyHours}h of hourly history; need at least ${requiredHours}h (${opts.minHistoryHours}h evaluation + ${H}h outcome horizon).`,
      historyHours,
      requiredHours,
      periodStart: allSlots.length ? new Date(allSlots[0]!).toISOString() : null,
      periodEnd: allSlots.length ? new Date(allSlots[allSlots.length - 1]!).toISOString() : null,
      calibration,
      assumptions,
    };
  }

  const meta = new Map(assets.map((a) => [a.id, a]));
  const idx = new Map<string, Map<number, number>>();
  for (const [id, s] of series) idx.set(id, new Map(s.map((p, i) => [p.slotTime.getTime(), i])));

  const last = allSlots[allSlots.length - 1]!;
  const evalSlots = allSlots.filter((t) => t - allSlots[0]! >= opts.snapshotWindow * HOUR_MS && t + H * HOUR_MS <= last);
  const testStartIdx = Math.floor(evalSlots.length * (1 - opts.finalTestFraction));
  const devSlots = evalSlots.slice(0, testStartIdx);
  const testSlots = evalSlots.slice(testStartIdx);

  const fopts = { snapshotWindow: opts.snapshotWindow, statisticalWarmup: STATISTICAL_WARMUP_SNAPSHOTS, paperNotionalUsd: 1_000 };

  const runPeriod = (slots: number[]) => {
    const strat: Pick[] = [];
    const mom: Pick[] = [];
    let positives = 0;
    let negatives = 0;
    let stratFP = 0;
    let stratTP = 0;
    let momFP = 0;
    let momTP = 0;
    const busy = { s: new Map<string, number>(), m: new Map<string, number>() };
    const btc: number[] = [];
    const mkt: number[] = [];

    for (const t of slots) {
      const slot = new Date(t);
      const base = new Map<string, { fv: FeatureVector; cur: BacktestSnapshot; hist: BacktestSnapshot[] }>();
      for (const [id, s] of series) {
        const i = idx.get(id)!.get(t);
        if (i === undefined) continue; // not observed at t → not in the point-in-time universe
        const hist = s.slice(Math.max(0, i - STATISTICAL_WARMUP_SNAPSHOTS - 1), i + 1);
        base.set(id, { fv: computeBaseFeatures(hist, fopts), cur: s[i]!, hist });
      }
      const btcId = assets.find((a) => a.isBenchmark && a.symbol === "BTC")?.id;
      const ethId = assets.find((a) => a.isBenchmark && a.symbol === "ETH")?.id;
      const universe = [...base.entries()].filter(([id, b]) => !EXCLUDED_MARKET.has(meta.get(id)?.assetClass ?? "") && !b.cur.isStale).map(([, b]) => b.fv);
      const market = buildMarketContext({ btc: btcId ? (base.get(btcId)?.fv ?? null) : null, eth: ethId ? (base.get(ethId)?.fv ?? null) : null, universe });

      const outputs = [...base.entries()].map(([id, b]) => {
        const a = meta.get(id)!;
        const input: ScreenInput = {
          assetId: id,
          symbol: a.symbol,
          name: a.name,
          assetClass: a.assetClass,
          isBenchmark: a.isBenchmark,
          hasCurrentSnapshot: true,
          latest: {
            price: b.cur.price,
            marketCap: b.cur.marketCap,
            fullyDilutedValuation: b.cur.fullyDilutedValuation,
            volumeRolling24h: b.cur.volumeRolling24h,
            isStale: b.cur.isStale,
            completeness: b.cur.completeness,
            marketCapProvenance: b.cur.marketCapProvenance,
            qualityFlags: b.cur.qualityFlags,
          },
          features: applyMarketContext(b.fv, market),
        };
        return { out: screenAsset(input, market, params), fv: input.features };
      });
      const ranked = rankAndShortlist(outputs.map((o) => o.out), opts.shortlistSize, params.minShortlistScore);

      // Labels for every eligible asset at t (future data used only here).
      const end = t + H * HOUR_MS;
      const futureRet = (id: string) => {
        const s = series.get(id)!;
        const i0 = idx.get(id)!.get(t);
        const i1 = idx.get(id)!.get(end);
        if (i0 === undefined || i1 === undefined) return null;
        const p0 = s[i0]!.price;
        const p1 = s[i1]!.price;
        return p0 && p1 ? p1 / p0 - 1 : null;
      };
      const rets = [...base.keys()].filter((id) => !EXCLUDED_MARKET.has(meta.get(id)?.assetClass ?? "")).map(futureRet).filter((x): x is number => x !== null);
      const benchRet = rets.length >= 5 ? median(rets) : null;
      if (benchRet !== null) mkt.push(benchRet);
      if (btcId) {
        const b = futureRet(btcId);
        if (b !== null) btc.push(b);
      }
      const label = (id: string) => {
        const s = series.get(id)!;
        const i0 = idx.get(id)!.get(t)!;
        const ref = s[i0]!.price!;
        const o = evaluateTarget(params.target, slot, ref, s.slice(i0 + 1, i0 + 1 + H + 2), benchRet, new Date(end));
        return o.status === "hit";
      };
      const eligible = ranked.filter((r) => r.eligible);
      const labels = new Map(eligible.map((r) => [r.assetId, label(r.assetId)]));
      for (const v of labels.values()) v ? positives++ : negatives++;

      const stratPicks = ranked.filter((r) => r.shortlisted);
      const momPicks = eligible
        .map((r) => ({ r, ret2: outputs.find((o) => o.out.assetId === r.assetId)!.fv.values.ret_2h ?? null }))
        .filter((x) => x.ret2 !== null)
        .sort((a, b) => b.ret2! - a.ret2!)
        .slice(0, opts.shortlistSize)
        .map((x) => x.r);

      const simulate = (id: string, classification: string): SimResult => {
        const s = series.get(id)!;
        const i0 = idx.get(id)!.get(t)!;
        const ref = s[i0]!.price!;
        const breakout = classification === "move_underway" ? params.entryBreakoutPct * 2 : params.entryBreakoutPct;
        return simulatePosition(
          {
            signalSlot: slot,
            entryTriggerPrice: ref * (1 + breakout),
            stopPct: params.stopPct,
            targetPct: params.targetPct,
            trailActivatePct: params.trailActivatePct,
            trailPct: params.trailPct,
            maxHoldHours: params.maxHoldHours,
            signalExpiresAt: new Date(t + params.entryExpiryHours * HOUR_MS),
            feeBps: opts.feeBps,
            slippageBps: opts.slippageBps,
          },
          s.slice(i0 + 1, i0 + 1 + params.entryExpiryHours + params.maxHoldHours + 4),
          new Date(last),
        );
      };
      const take = (picks: typeof ranked, book: Pick[], busyMap: Map<string, number>, kind: "s" | "m") => {
        for (const p of picks) {
          if ((busyMap.get(p.assetId) ?? 0) > t) continue;
          const sim = simulate(p.assetId, p.classification);
          const hit = labels.get(p.assetId) ?? false;
          book.push({ assetId: p.assetId, slot, sim, hit });
          busyMap.set(p.assetId, (sim.exitAt ?? new Date(t + (params.entryExpiryHours + params.maxHoldHours) * HOUR_MS)).getTime());
          if (kind === "s") hit ? stratTP++ : stratFP++;
          else hit ? momTP++ : momFP++;
        }
      };
      take(stratPicks, strat, busy.s, "s");
      take(momPicks, mom, busy.m, "m");
    }
    return {
      strategy: metrics(strat, stratTP, stratFP, positives, negatives),
      momentum: metrics(mom, momTP, momFP, positives, negatives),
      btc,
      mkt,
    };
  };

  const dev = runPeriod(devSlots);
  const folds: NonNullable<BacktestReportData["folds"]> = [];
  for (let i = 0; i < devSlots.length; i += opts.foldHours) {
    const f = devSlots.slice(i, i + opts.foldHours);
    if (f.length < opts.foldHours / 2) break;
    const r = runPeriod(f);
    folds.push({ start: new Date(f[0]!).toISOString(), end: new Date(f[f.length - 1]!).toISOString(), strategy: r.strategy, momentum: r.momentum });
  }
  const test = opts.includeFinalTest && testSlots.length ? runPeriod(testSlots) : null;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    status: "completed",
    historyHours,
    requiredHours,
    periodStart: new Date(allSlots[0]!).toISOString(),
    periodEnd: new Date(last).toISOString(),
    developmentPeriod: devSlots.length ? { start: new Date(devSlots[0]!).toISOString(), end: new Date(devSlots[devSlots.length - 1]!).toISOString() } : undefined,
    finalTestPeriod: testSlots.length
      ? { start: new Date(testSlots[0]!).toISOString(), end: new Date(testSlots[testSlots.length - 1]!).toISOString(), evaluated: !!test }
      : undefined,
    folds,
    strategy: dev.strategy,
    momentumBaseline: dev.momentum,
    btcBuyHold: { avgReturnPerWindow: avg(dev.btc), windows: dev.btc.length },
    marketMedian: { avgReturnPerWindow: avg(dev.mkt), windows: dev.mkt.length },
    finalTest: test ? { strategy: test.strategy, momentum: test.momentum } : null,
    calibration,
    assumptions,
  };
}

function metrics(picks: Pick[], tp: number, fp: number, positives: number, negatives: number): StrategyMetrics {
  const trades = picks.filter((p) => p.sim.status === "closed" && p.sim.netReturn !== null);
  const rets = trades.sort((a, b) => a.sim.exitAt!.getTime() - b.sim.exitAt!.getTime()).map((p) => p.sim.netReturn!);
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of rets) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity / peak - 1);
  }
  return {
    signals: picks.length,
    trades: trades.length,
    targetHits: tp,
    precision: tp + fp ? tp / (tp + fp) : null,
    falsePositiveRate: negatives ? fp / negatives : null,
    recall: positives ? tp / positives : null,
    avgNetReturn: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null,
    totalNetReturn: rets.length ? equity - 1 : null,
    maxDrawdown: rets.length ? mdd : null,
    winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : null,
    ambiguousOrdering: picks.filter((p) => p.sim.ambiguousOrdering).length,
  };
}

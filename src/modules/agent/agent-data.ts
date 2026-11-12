import type { DValue } from '../../common/utils/decimal.js';

/**
 * Pure shaping of stored data for the agent's tools. Derived numbers (changes, highs, lows) are
 * computed here with exact decimals, so the model reads them instead of doing arithmetic; values
 * are rounded only for display (percentages to 2 dp).
 */

/** One stored hourly observation, as exact decimals. */
export interface SnapshotPoint {
  slotTime: Date;
  observedAt: Date | null;
  price: DValue | null;
  marketCap: DValue | null;
  volume24h: DValue | null;
  rank: number | null;
  isStale: boolean;
}

const fixed = (d: DValue | null | undefined) =>
  d === null || d === undefined ? null : d.toFixed();

/** Percentage change from `from` to `to` (2 dp); null when either is missing or `from` is zero. */
export function pctChange(from: DValue | null, to: DValue | null): string | null {
  if (from === null || to === null || from.isZero()) return null;
  return to.div(from).minus(1).times(100).toDecimalPlaces(2).toFixed(2);
}

/** Evenly spaced subset of at most `max` items that always keeps the first and the last. */
export function downsample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max <= 1) return items.slice(-1);
  const step = (items.length - 1) / (max - 1);
  const picked: T[] = [];
  for (let i = 0; i < max; i++) picked.push(items[Math.round(i * step)]!);
  return picked;
}

/**
 * Price change over the `hours` before the newest priced observation (points oldest first). The
 * reference is the newest observation at or before that time, accepted up to 3 h earlier (26 h
 * for windows of 7 days and more, where old detail may be thinned to one row per day).
 */
export function changeOver(
  points: readonly SnapshotPoint[],
  hours: number,
): { changePct: string | null; since: string | null } {
  const priced = points.filter((p) => p.price !== null);
  const last = priced.at(-1);
  if (!last) return { changePct: null, since: null };
  const target = last.slotTime.getTime() - hours * 3_600_000;
  const tolerance = (hours >= 168 ? 26 : 3) * 3_600_000;
  let ref: SnapshotPoint | undefined;
  for (const p of priced) {
    if (p.slotTime.getTime() > target) break;
    ref = p;
  }
  if (!ref || target - ref.slotTime.getTime() > tolerance) return { changePct: null, since: null };
  return { changePct: pctChange(ref.price, last.price), since: ref.slotTime.toISOString() };
}

/** Summary of a price series: range, extremes and changes (points oldest first). */
export function priceSummary(points: readonly SnapshotPoint[]) {
  const priced = points.filter((p) => p.price !== null);
  const first = priced[0];
  const last = priced.at(-1);
  if (!first || !last) return { observations: points.length, priced: 0 };
  let high = first;
  let low = first;
  for (const p of priced) {
    if (p.price!.gt(high.price!)) high = p;
    if (p.price!.lt(low.price!)) low = p;
  }
  const withVolume = points.filter((p) => p.volume24h !== null);
  return {
    observations: points.length,
    priced: priced.length,
    from: first.slotTime.toISOString(),
    to: last.slotTime.toISOString(),
    priceFirstUsd: fixed(first.price),
    priceLastUsd: fixed(last.price),
    priceChangePct: pctChange(first.price, last.price),
    highUsd: fixed(high.price),
    highAt: high.slotTime.toISOString(),
    lowUsd: fixed(low.price),
    lowAt: low.slotTime.toISOString(),
    lastVsHighPct: pctChange(high.price, last.price),
    lastVsLowPct: pctChange(low.price, last.price),
    volume24hFirstUsd: fixed(withVolume[0]?.volume24h),
    volume24hLastUsd: fixed(withVolume.at(-1)?.volume24h),
    volume24hChangePct: pctChange(
      withVolume[0]?.volume24h ?? null,
      withVolume.at(-1)?.volume24h ?? null,
    ),
    staleObservations: points.filter((p) => p.isStale).length,
  };
}

/** Observations as compact JSON rows (exact decimal strings). */
export function pointRows(points: readonly SnapshotPoint[]) {
  return points.map((p) => ({
    t: p.slotTime.toISOString(),
    priceUsd: fixed(p.price),
    marketCapUsd: fixed(p.marketCap),
    volume24hUsd: fixed(p.volume24h),
    rank: p.rank,
    ...(p.isStale ? { stale: true } : {}),
  }));
}

/** BTC / ETH regime facts from one reference asset's observations (oldest first). */
export function regimeFacts(points: readonly SnapshotPoint[]) {
  const last = points.filter((p) => p.price !== null).at(-1);
  if (!last) return { available: false as const, reason: 'no stored observations' };
  const over = (h: number) => changeOver(points, h);
  return {
    available: true as const,
    priceUsd: fixed(last.price),
    slotTime: last.slotTime.toISOString(),
    observedAt: last.observedAt?.toISOString() ?? null,
    change24h: over(24),
    change72h: over(72),
    change7d: over(168),
    change30d: over(720),
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const pick = (o: Json, keys: readonly string[]): Json =>
  Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
const clip = (v: unknown, max: number) =>
  typeof v === 'string' && v.length > max ? `${v.slice(0, max)}…` : v;

/**
 * The parts of the full calculation trace (`ReadModelService.assetTrace`) the agent needs, without
 * raw source payloads, response hashes or per-market venue rows.
 */
export function slimTrace(trace: Json) {
  const r = obj(trace.record);
  const batch = obj(trace.batch);
  const scanRun = obj(trace.scanRun);
  const current = obj(trace.current);
  const lbank = obj(trace.lbank);
  const venues = obj(trace.venues);
  const summary = obj(venues.summary);
  const daily = obj(trace.daily);
  return {
    coin: {
      ...pick(r, ['cmcId', 'symbol', 'name', 'slug', 'rank', 'dateAdded', 'ageDays', 'assetClass']),
      tags: obj(trace.asset).tags ?? null,
    },
    dataSource: {
      isLiveData: batch.isLive ?? null,
      batchId: batch.id ?? null,
      batchStatus: batch.status ?? null,
      batchStatusReasons: batch.statusReasons ?? [],
      slotTime: batch.slotTime ?? null,
      crawledAt: batch.crawledAt ?? null,
    },
    scan: {
      computedAt: r.computedAt ?? null,
      rulesetVersion: r.rulesetVersion ?? null,
      queueStatus: scanRun.queueStatus ?? null,
      warnings: scanRun.warnings ?? [],
    },
    current: {
      priceUsd: r.priceUsd ?? null,
      circulatingMarketCapUsd: r.capUsd ?? null,
      volume24hUsd: r.volume24hUsd ?? null,
      providerObservedAt: r.observedAt ?? null,
      status: r.currentStatus ?? null,
      reason: r.currentReason ?? null,
      currentVmc: r.currentVmc ?? null,
      formula: current.formula ?? null,
    },
    windows: arr(trace.windows).map((w) => {
      const x = obj(w);
      const pass = x.pass ? obj(x.pass) : null;
      return {
        days: x.days,
        role: x.role,
        mean: x.mean ?? null,
        meanReason: x.reason ?? null,
        multiple: pass?.multiple ?? null,
        result: pass ? (pass.status ?? null) : 'context only',
        resultReason: pass?.reason ?? null,
      };
    }),
    stars: r.stars ?? null,
    inQueue: r.inQueue ?? null,
    queueOrder: r.queueOrder ?? null,
    ranking: trace.ranking ?? null,
    eligibility: { status: r.eligibilityStatus ?? null, reasons: r.eligibilityReasons ?? [] },
    flags: [...arr(r.flags), ...arr(r.venueFlags)],
    lbank: {
      status: lbank.status ?? null,
      reason: lbank.reason ?? null,
      pairs: arr(lbank.pairs).map((p) =>
        pick(obj(p), ['marketPair', 'mapping', 'trading', 'tradingSource', 'volumeUsd']),
      ),
    },
    venues: {
      review: venues.review ?? null,
      dataStatus: summary.dataStatus ?? null,
      observedAt: summary.observedAt ?? null,
      topExchange: summary.topExchange ?? null,
      pairsUsed: summary.pairsUsed ?? null,
      exchanges: arr(summary.exchanges)
        .slice(0, 8)
        .map((e) => pick(obj(e), ['name', 'pairs', 'volumeUsd', 'volumePercent'])),
    },
    dailyRows: {
      asOfDate: daily.asOfDate ?? null,
      note: 'Completed UTC days, newest first; vmc = volumeUsd / marketCapUsd.',
      rows: arr(daily.used).map((d) =>
        pick(obj(d), ['dateUtc', 'volumeUsd', 'marketCapUsd', 'closeUsd', 'vmc', 'valid']),
      ),
    },
    humanReviews: arr(trace.reviews)
      .slice(0, 2)
      .map((x) => {
        const rv = obj(x);
        return {
          ...pick(rv, [
            'reviewedAt',
            'finalDecision',
            'eventDay',
            'venueDecision',
            'candleState',
            'marketRegime',
            'priorPumpResponse',
            'rangeLow',
          ]),
          rationale: clip(rv.rationale ?? null, 400),
        };
      }),
  };
}

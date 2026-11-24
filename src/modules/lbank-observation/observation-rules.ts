import { D, type DValue } from '../../common/utils/decimal.js';

import type { ResolvedPair } from '../strategy/index.js';

import {
  ENTRY_LOOKBACK_MS,
  type EligibilityClass,
  type ExtremeOrder,
  FINALIZE_RETRY_MS,
  type ListingStatus,
  MAPPING_MAX_PRICE_DEVIATION,
  MAX_ENTRY_DELAY_MS,
  MAX_ENTRY_STALENESS_MS,
  MINUTE_MS,
  type MappingStatus,
  type ObservationStatus,
  PREFERRED_QUOTE,
  OBS_REASON as R,
  SIGNAL_TRADE_WINDOW_MS,
  WINDOW_MS,
} from './observation.constants.js';

/**
 * LBank Spot Price Observation rules (docs/lbank-spot-observation.md § 4–6), pure and exact: the
 * window, the entry reference, the two price extremes, coverage, status, and the LBank Spot pair of
 * a CMC event. No I/O; edge cases are in observation-rules.spec.ts. Every price is an LBank Spot
 * candle value; the CMC price appears only in the identity check (`entryDeviatesFromCmc`).
 */

/** One LBank Spot 1-minute candle (UTC open time; exact decimals as the API sent them). */
export interface Bar {
  openMs: number;
  open: DValue;
  high: DValue;
  low: DValue;
  close: DValue;
  volume: DValue;
}

const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE_MS) * MINUTE_MS;

// ── Window ──────────────────────────────────────────────────────────────────────────────────

export interface ObsWindow {
  t0Ms: number;
  /** Exactly t0 + 168 h. */
  cutoffMs: number;
  /** The earliest bar that may be the entry: the first minute opening at or after t0. */
  entryFromMs: number;
  /** Bars opening before this end at or before the cutoff; the bar at this minute straddles it. */
  endExclusiveMs: number;
  /** Whole minutes in [entryFromMs, endExclusiveMs): 10 080 when t0 is on a minute, else 10 079. */
  expectedBars: number;
  /** [t0, entryFromMs) is not observed by any bar (0 when t0 is on a minute). */
  startUnobservedMs: number;
  /**
   * [endExclusiveMs, cutoffMs) is not observed: the 1-minute bar covering it extends past the cutoff,
   * so its High / Low may come from after it and is never used (no finer timestamped data is read).
   */
  boundaryUnobservedMs: number;
}

export function observationWindow(t0: Date): ObsWindow {
  const t0Ms = t0.getTime();
  const cutoffMs = t0Ms + WINDOW_MS;
  const entryFromMs = ceilMinute(t0Ms);
  const endExclusiveMs = floorMinute(cutoffMs);
  return {
    t0Ms,
    cutoffMs,
    entryFromMs,
    endExclusiveMs,
    expectedBars: Math.max(0, (endExclusiveMs - entryFromMs) / MINUTE_MS),
    startUnobservedMs: entryFromMs - t0Ms,
    boundaryUnobservedMs: cutoffMs - endExclusiveMs,
  };
}

/** Bars sorted by open time, one per minute (a later duplicate is dropped). */
export function normalizeBars(bars: readonly Bar[]): Bar[] {
  const seen = new Set<number>();
  return [...bars]
    .sort((a, b) => a.openMs - b.openMs)
    .filter((b) => (seen.has(b.openMs) ? false : (seen.add(b.openMs), true)));
}

// ── Entry reference ─────────────────────────────────────────────────────────────────────────

export type EntryResult =
  | { kind: 'pending' }
  | { kind: 'none' }
  | { kind: 'too_late'; bar: Bar; delayMs: number }
  | {
      kind: 'ok';
      bar: Bar;
      price: DValue;
      delayMs: number;
      /** Open time of the last bar with trades before the entry bar, within the look-back. */
      lastTradeBarMs: number | null;
      stale: boolean;
    };

/**
 * The entry reference is the OPEN of the first bar opening at or after t0 (never a bar that opened
 * before the signal: its High / Low may precede it). `syncedUntilMs` is how far the pair's series
 * has been fetched: without a bar, "pending" until the allowed delay has been fetched, then "none".
 */
export function selectEntry(
  sortedBars: readonly Bar[],
  w: ObsWindow,
  syncedUntilMs: number | null,
): EntryResult {
  const bar = sortedBars.find((b) => b.openMs >= w.entryFromMs && b.openMs < w.endExclusiveMs);
  const allowedUntil = w.t0Ms + MAX_ENTRY_DELAY_MS;
  if (!bar)
    return syncedUntilMs === null || syncedUntilMs <= allowedUntil
      ? { kind: 'pending' }
      : { kind: 'none' };
  const delayMs = bar.openMs - w.t0Ms;
  if (bar.openMs > allowedUntil) {
    // An earlier minute may simply not be fetched yet.
    if (syncedUntilMs === null || syncedUntilMs <= w.entryFromMs) return { kind: 'pending' };
    return { kind: 'too_late', bar, delayMs };
  }
  let lastTradeBarMs: number | null = null;
  for (const b of sortedBars) {
    if (b.openMs >= bar.openMs) break;
    if (b.openMs >= bar.openMs - ENTRY_LOOKBACK_MS && b.volume.gt(0)) lastTradeBarMs = b.openMs;
  }
  const stale = lastTradeBarMs === null || bar.openMs - lastTradeBarMs > MAX_ENTRY_STALENESS_MS;
  return { kind: 'ok', bar, price: bar.open, delayMs, lastTradeBarMs, stale };
}

// ── Extremes ────────────────────────────────────────────────────────────────────────────────

export interface Extremes {
  high: DValue;
  highBarMs: number;
  low: DValue;
  lowBarMs: number;
  /** By bar time; SAME_BAR: the order inside that minute is unknown. */
  order: ExtremeOrder;
  /** Lowest Low from the entry up to and including the bar of the eventual highest High (descriptive). */
  lowBeforeHigh: DValue;
  lowBeforeHighBarMs: number;
  tradedBars: number;
}

/**
 * The highest High and lowest Low of bars with trades in [fromMs, toExclusiveMs): two independent
 * extremes. A bar without trades carries the previous close as O = H = L = C, which may be a
 * pre-entry price, so it is never an extreme. Ties go to the earliest bar.
 */
export function computeExtremes(
  sortedBars: readonly Bar[],
  fromMs: number,
  toExclusiveMs: number,
): Extremes | null {
  let hi: Bar | null = null;
  let lo: Bar | null = null;
  let traded = 0;
  for (const b of sortedBars) {
    if (b.openMs < fromMs || b.openMs >= toExclusiveMs || !b.volume.gt(0)) continue;
    traded++;
    if (!hi || b.high.gt(hi.high)) hi = b;
    if (!lo || b.low.lt(lo.low)) lo = b;
  }
  if (!hi || !lo) return null;
  let lbh: Bar | null = null;
  for (const b of sortedBars) {
    if (b.openMs < fromMs || b.openMs > hi.openMs || !b.volume.gt(0)) continue;
    if (!lbh || b.low.lt(lbh.low)) lbh = b;
  }
  return {
    high: hi.high,
    highBarMs: hi.openMs,
    low: lo.low,
    lowBarMs: lo.openMs,
    order: hi.openMs < lo.openMs ? 'HIGH_FIRST' : lo.openMs < hi.openMs ? 'LOW_FIRST' : 'SAME_BAR',
    lowBeforeHigh: lbh!.low,
    lowBeforeHighBarMs: lbh!.openMs,
    tradedBars: traded,
  };
}

/** 100 × (price / entry − 1), exact (80 significant digits); negative for a decline. */
export function pctChange(price: DValue, entry: DValue): DValue {
  return price.div(entry).minus(1).times(100);
}

// ── Coverage ────────────────────────────────────────────────────────────────────────────────

export interface Coverage {
  expectedBars: number;
  /** Exclusive end of the part of the window that has been fetched. */
  observedThroughMs: number;
  expectedSoFar: number;
  presentBars: number;
  missingBars: number;
  /** [from, to) of minutes the source answered without a bar, oldest first. */
  missingRanges: Array<[number, number]>;
  tradedBars: number;
  zeroVolumeBars: number;
}

export function coverage(
  sortedBars: readonly Bar[],
  w: ObsWindow,
  syncedUntilMs: number | null,
): Coverage {
  const through = Math.max(
    w.entryFromMs,
    Math.min(w.endExclusiveMs, floorMinute(syncedUntilMs ?? w.entryFromMs)),
  );
  const missingRanges: Array<[number, number]> = [];
  let expect = w.entryFromMs;
  let present = 0;
  let traded = 0;
  for (const b of sortedBars) {
    if (b.openMs < w.entryFromMs || b.openMs >= through) continue;
    if (b.openMs > expect) missingRanges.push([expect, b.openMs]);
    expect = b.openMs + MINUTE_MS;
    present++;
    if (b.volume.gt(0)) traded++;
  }
  if (expect < through) missingRanges.push([expect, through]);
  const expectedSoFar = (through - w.entryFromMs) / MINUTE_MS;
  return {
    expectedBars: w.expectedBars,
    observedThroughMs: through,
    expectedSoFar,
    presentBars: present,
    missingBars: expectedSoFar - present,
    missingRanges,
    tradedBars: traded,
    zeroVolumeBars: present - traded,
  };
}

// ── Spot pair of a CMC event ────────────────────────────────────────────────────────────────

export interface SpotPairMapping {
  status: Exclude<MappingStatus, 'PENDING'>;
  /** LBank's own symbol, e.g. `0g_usdt` (from CMC's market URL for the pair). */
  symbol: string | null;
  base: string | null;
  quote: string | null;
  reasons: string[];
  evidence: Record<string, unknown>;
}

/** LBank's symbol in a CMC market URL (`https://www.lbank.com/en-US/trade/0g_usdt/?…`). */
export function lbankSpotSymbolFromUrl(url: string | null): string | null {
  const m = url
    ? /lbank\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?trade\/([a-z0-9]+_[a-z0-9]+)\/?/.exec(url)
    : null;
  return m ? m[1]! : null;
}

/** LBank's contract symbol in a CMC perpetual market URL (`https://www.lbank.com/futures/soxlusdt/`). */
export function lbankContractFromUrl(url: string | null): string | null {
  const m = url ? /lbank\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?futures\/([a-z0-9]+)\/?/.exec(url) : null;
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * The LBank Spot pair of an event, from the pairs the scanner resolved for it at detection (CMC's
 * LBank Spot markets list, matched by CMC id — never by ticker). One USDT pair is required; the
 * LBank symbol is the one in CMC's market URL for that very market, so a reused ticker cannot
 * substitute another asset. Several USDT pairs, or no verifiable symbol, is ambiguous.
 */
export function resolveSpotPair(pairs: readonly ResolvedPair[]): SpotPairMapping {
  const usable = pairs.filter(
    (p) => (p.mapping === 'OK' || p.mapping === 'CONFIRMED') && p.trading !== 'NOT_TRADABLE',
  );
  const usdt = usable.filter((p) => p.quoteSymbol.toUpperCase() === PREFERRED_QUOTE);
  const evidence = {
    candidates: pairs.map((p) => ({
      marketPair: p.marketPair,
      mapping: p.mapping,
      trading: p.trading,
      tradingSource: p.tradingSource,
      marketUrl: p.marketUrl,
    })),
  };
  if (!usdt.length)
    return {
      status: 'NONE',
      symbol: null,
      base: null,
      quote: null,
      reasons: [R.noUsdtPair],
      evidence: { ...evidence, otherQuotes: usable.map((p) => p.quoteSymbol) },
    };
  if (usdt.length > 1)
    return {
      status: 'AMBIGUOUS',
      symbol: null,
      base: null,
      quote: null,
      reasons: [R.multipleUsdtPairs],
      evidence,
    };
  const p = usdt[0]!;
  const symbol = lbankSpotSymbolFromUrl(p.marketUrl);
  if (!symbol || !symbol.endsWith(`_${PREFERRED_QUOTE.toLowerCase()}`))
    return {
      status: 'AMBIGUOUS',
      symbol: null,
      base: null,
      quote: null,
      reasons: [R.pairSymbolUnverified],
      evidence: { ...evidence, marketUrl: p.marketUrl },
    };
  return {
    status: 'OK',
    symbol,
    base: symbol.slice(0, symbol.lastIndexOf('_')).toUpperCase(),
    quote: PREFERRED_QUOTE,
    reasons: [],
    evidence: {
      ...evidence,
      chosen: p.marketPair,
      marketUrl: p.marketUrl,
      cmcEvidence: p.evidence,
      rule: "the single USDT pair of CMC's LBank Spot list for this CMC id; LBank symbol from its market URL",
    },
  };
}

/** Identity check only: |entry / CMC price − 1| beyond the limit (CMC price never enters a return). */
export function entryDeviatesFromCmc(entry: DValue, cmcPrice: DValue): boolean {
  return entry.div(cmcPrice).minus(1).abs().gt(new D(MAPPING_MAX_PRICE_DEVIATION));
}

// ── Spot / Futures at the signal ────────────────────────────────────────────────────────────

export interface SpotEvidenceInput {
  /** LBank's Spot pairs list fetched within the evidence lag of t0: listed or not; null = no list. */
  listed: boolean | null;
  /** LBank answered "currency pair nonsupport" within the evidence lag of t0. */
  unsupportedNearSignal: boolean;
  /** A bar exists in the hour before t0, and the entry bar exists: the series spans the signal. */
  barBeforeT0: boolean;
  entryBar: boolean;
  /** A bar with trades in [t0 − 1 h, t0 + 1 h]. */
  tradeNearSignal: boolean;
}

export interface ListingDecision {
  status: ListingStatus;
  reasons: string[];
}

/**
 * Whether the LBank Spot pair was available and trading at t0. Candles are historical evidence: a
 * series with bars before and at the signal shows the pair existed then. NO needs both the list
 * near the signal and the API's own answer (or the absence of any bar). Conflicts are UNKNOWN.
 */
export function spotAtSignal(
  i: SpotEvidenceInput,
): ListingDecision & { trading: 'TRADES_OBSERVED' | 'NO_RECENT_TRADES' | 'UNKNOWN' } {
  const trading = i.tradeNearSignal
    ? 'TRADES_OBSERVED'
    : i.entryBar
      ? 'NO_RECENT_TRADES'
      : 'UNKNOWN';
  if (i.barBeforeT0 && i.entryBar) {
    if (i.listed === false)
      return { status: 'UNKNOWN', trading, reasons: [R.spotEvidenceConflict] };
    return { status: 'YES', trading, reasons: i.tradeNearSignal ? [] : [R.noTradesNearSignal] };
  }
  // LBank's own "currency pair nonsupport" near the signal, or its pairs list without the pair and
  // no bar before the signal: not available at t0.
  if (!i.entryBar && (i.unsupportedNearSignal || (i.listed === false && !i.barBeforeT0)))
    return {
      status: 'NO',
      trading,
      reasons: [i.unsupportedNearSignal ? R.pairUnsupported : R.spotNotListed],
    };
  return { status: 'UNKNOWN', trading, reasons: [R.spotEvidenceMissing] };
}

export interface FuturesEvidenceInput {
  /** CMC's LBank Futures list as of t0 (the latest verified list fetched before t0). */
  cmc: { status: ListingStatus; contracts: readonly string[]; reason: string | null };
  /** LBank's own contract list fetched within the evidence lag of t0; null = none. */
  lbank: { contracts: ReadonlyMap<string, { base: string; volume24h: DValue | null }> } | null;
  coinSymbol: string;
}

/**
 * Whether an LBank Futures contract was available and trading at t0: evidence from before the
 * signal (CMC's list, by CMC id) and right after it (LBank's own list) must agree. YES needs the
 * CMC-listed contract in LBank's list with 24 h volume; NO needs both lists without it. A contract
 * listed today proves nothing about earlier signals, so anything else stays UNKNOWN.
 */
export function futuresAtSignal(i: FuturesEvidenceInput): ListingDecision {
  if (!i.lbank) return { status: 'UNKNOWN', reasons: [R.futuresSnapshotMissing] };
  if (i.cmc.status === 'UNKNOWN')
    return { status: 'UNKNOWN', reasons: [`${R.futuresList}:${i.cmc.reason ?? 'UNKNOWN'}`] };
  if (i.cmc.status === 'YES') {
    const hit = i.cmc.contracts.find((c) => i.lbank!.contracts.has(c));
    if (!hit) return { status: 'UNKNOWN', reasons: [R.futuresEvidenceConflict] };
    const vol = i.lbank.contracts.get(hit)!.volume24h;
    return vol !== null && vol.gt(0)
      ? { status: 'YES', reasons: [] }
      : { status: 'UNKNOWN', reasons: [R.futuresNoRecentVolume] };
  }
  const ticker = i.coinSymbol.toUpperCase();
  for (const c of i.lbank.contracts.values())
    if (c.base.toUpperCase() === ticker)
      return { status: 'UNKNOWN', reasons: [R.futuresTickerUnverified] };
  return { status: 'NO', reasons: [] };
}

export function classifyEligibility(
  mapping: MappingStatus,
  spot: ListingStatus,
  futures: ListingStatus,
): EligibilityClass {
  if (mapping === 'PENDING') return 'PENDING';
  if (mapping === 'AMBIGUOUS') return 'MAPPING_AMBIGUOUS';
  if (mapping === 'NONE' || spot === 'NO') return 'SPOT_UNAVAILABLE';
  if (spot === 'UNKNOWN') return 'SPOT_UNKNOWN';
  return futures === 'YES'
    ? 'SPOT_AND_FUTURES'
    : futures === 'NO'
      ? 'SPOT_ONLY'
      : 'SPOT_FUTURES_UNKNOWN';
}

// ── Status ──────────────────────────────────────────────────────────────────────────────────

export interface StatusInput {
  nowMs: number;
  w: ObsWindow;
  mapping: MappingStatus;
  mappingReasons: readonly string[];
  spot: ListingDecision;
  entry: EntryResult;
  /** The entry deviates from the CMC price by more than the identity limit. */
  entryDeviates: boolean;
  cov: Coverage;
  extremes: Extremes | null;
  /** LBank answered "currency pair nonsupport" for this pair. */
  pairUnsupported: boolean;
  fetchError: string | null;
}

export interface StatusDecision {
  status: ObservationStatus;
  terminal: boolean;
  reasons: string[];
}

/**
 * ACTIVE while the window runs or data is still being fetched; FINAL only after t0 + 168 h with every
 * expected bar present, a fresh entry and verified Spot availability; otherwise an explicit terminal
 * status once the retries after the window are over. Provisional extremes are kept on ACTIVE and
 * PARTIAL observations but never enter final statistics.
 */
export function observationStatus(i: StatusInput): StatusDecision {
  const done = (status: ObservationStatus, reasons: string[]): StatusDecision => ({
    status,
    terminal: true,
    reasons: [...new Set(reasons)],
  });
  const pastRetries = i.nowMs > i.w.cutoffMs + FINALIZE_RETRY_MS;
  const extra = i.fetchError ? [R.fetchError] : [];
  if (i.mapping === 'AMBIGUOUS') return done('MAPPING_AMBIGUOUS', [...i.mappingReasons]);
  if (i.mapping === 'NONE') return done('DATA_UNAVAILABLE', [...i.mappingReasons]);
  if (i.mapping === 'PENDING')
    return pastRetries
      ? done('ELIGIBILITY_UNKNOWN', [R.mappingPending])
      : { status: 'ACTIVE', terminal: false, reasons: [R.mappingPending] };
  if (i.spot.status === 'NO') return done('DATA_UNAVAILABLE', [...i.spot.reasons]);

  const e = i.entry;
  if (e.kind === 'none')
    return done('DATA_UNAVAILABLE', [
      R.entryUnavailable,
      ...(i.pairUnsupported ? [R.pairUnsupported] : []),
    ]);
  if (e.kind === 'too_late') return done('DATA_UNAVAILABLE', [R.entryTooLate]);
  if (e.kind === 'pending') {
    if (i.pairUnsupported) return done('DATA_UNAVAILABLE', [R.pairUnsupported, R.entryUnavailable]);
    return pastRetries
      ? done('DATA_UNAVAILABLE', [R.entryUnavailable, R.fetchIncomplete, ...extra])
      : { status: 'ACTIVE', terminal: false, reasons: [R.entryPending, ...extra] };
  }
  if (i.entryDeviates) return done('MAPPING_AMBIGUOUS', [R.priceDeviation]);

  const reasons: string[] = [...i.spot.reasons.filter((r) => r !== R.noTradesNearSignal), ...extra];
  if (e.stale) reasons.push(R.entryStale);
  if (i.cov.missingBars > 0) reasons.push(R.missingBars);
  if (i.pairUnsupported) reasons.push(R.pairUnsupported);
  const elapsed = i.nowMs >= i.w.cutoffMs;
  const synced = i.cov.observedThroughMs >= i.w.endExclusiveMs;
  if (!elapsed || !synced) {
    if (elapsed && pastRetries) return done('PARTIAL', [...reasons, R.fetchIncomplete]);
    return {
      status: 'ACTIVE',
      terminal: false,
      reasons: [...reasons, elapsed ? R.fetchPending : R.windowOpen],
    };
  }
  if (!i.extremes) reasons.push(R.noTrades);
  if (i.spot.status !== 'YES')
    return pastRetries
      ? done('ELIGIBILITY_UNKNOWN', reasons)
      : { status: 'ACTIVE', terminal: false, reasons };
  if (i.cov.missingBars === 0 && !e.stale && i.extremes) return done('FINAL', reasons);
  if (i.cov.missingBars > 0 && !pastRetries) return { status: 'ACTIVE', terminal: false, reasons };
  return done('PARTIAL', reasons);
}

/** Minutes of the window the next fetch should cover for one observation; null when complete. */
export function neededFromMs(w: ObsWindow, syncedUntilMs: number | null): number | null {
  const from = w.entryFromMs - ENTRY_LOOKBACK_MS;
  if (syncedUntilMs !== null && syncedUntilMs >= w.endExclusiveMs) return null;
  return syncedUntilMs === null || syncedUntilMs < from ? from : syncedUntilMs;
}

/** Whether a bar with trades lies in [t0 − 1 h, t0 + 1 h] (trading at the signal). */
export function tradeNearSignal(sortedBars: readonly Bar[], w: ObsWindow): boolean {
  return sortedBars.some(
    (b) =>
      b.openMs >= w.t0Ms - ENTRY_LOOKBACK_MS &&
      b.openMs < w.t0Ms + SIGNAL_TRADE_WINDOW_MS &&
      b.volume.gt(0),
  );
}

/** Whether a bar exists in the hour before t0 (the series spans the signal). */
export function barBeforeSignal(sortedBars: readonly Bar[], w: ObsWindow): boolean {
  return sortedBars.some((b) => b.openMs < w.t0Ms && b.openMs >= w.t0Ms - ENTRY_LOOKBACK_MS);
}

import { D, type DValue } from '../../common/utils/decimal.js';

import type { ResolvedPair } from '../strategy/index.js';

import {
  type EligibilityClass,
  type ExtremesOrder,
  OBS_FLAG as F,
  FINALIZE_RETRY_MS,
  type GapState,
  type ListingStatus,
  MAPPING_MAX_PRICE_DEVIATION,
  MINUTE_MS,
  type MappingStatus,
  type ObservationStatus,
  PREFERRED_QUOTE,
  OBS_REASON as R,
  SIGNAL_TRADE_WINDOW_MS,
  SPOT_LOOKBACK_MS,
  type TradeCheckStatus,
  WINDOW_MS,
} from './observation.constants.js';

/**
 * LBank Spot Price Observation rules v2 (docs/lbank-spot-observation.md § 4–6), pure and exact: the
 * window [observation_start, observation_start + 168 h), the reference (the first verified LBank
 * Spot trade at or after the start), the highest and lowest verified trades, coverage, status and
 * review flags. No I/O: candles and checked minute trade lists come in as data; the job fetches
 * whatever `needs` lists. Edge cases: observation-rules.spec.ts.
 *
 * Candles only LOCATE candidates. LBank's 1-minute OPEN is the previous CLOSE and a candle's High or
 * Low can be that carried OPEN without any trade at that price, so no candle value is ever a price
 * here. Every price is a trade from a minute whose complete trade list was checked against its
 * candle. A candle's High / Low bounds the trades of its minute (0 of 180 checked minutes on all
 * production pairs had a trade outside it, 2026-11-25): candidates are taken in that order.
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

/** One LBank Spot trade (`/v2/supplement/trades.do`), exact. */
export interface Trade {
  id: string;
  timeMs: number;
  /** Position among the pair's trades of the same millisecond, in LBank's (stable) response order. */
  ord: number;
  price: DValue;
  qty: DValue;
  buyerMaker: boolean | null;
}

/** One minute's trade list, read completely and checked against the minute's candle. */
export interface MinuteCheck {
  minuteMs: number;
  status: TradeCheckStatus;
  /** Every trade of the minute in sequence (VERIFIED only; empty otherwise). */
  trades: readonly Trade[];
  tradeCount: number | null;
  qtySum: DValue | null;
  candleVolume: DValue | null;
  attempts: number;
  error: string | null;
}

/** What the candle series of the pair is known through (shared by its observations). */
export interface PairSync {
  /** Exclusive end of the minutes the API has answered (with or without a candle). */
  syncedUntilMs: number | null;
  /** LBank answered "currency pair nonsupport" (10008) and has not served candles since. */
  unsupported: boolean;
  /** The last candle request for the pair failed (error, timeout, rate limit). */
  lastFetchFailed: boolean;
  /** Minutes opening before this have closed (now less the closed-bar margin, floored). */
  closedNowMs: number;
}

export const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
export const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE_MS) * MINUTE_MS;

/** Trade sequence: time, then LBank's order inside one millisecond. */
export const cmpTrade = (a: Pick<Trade, 'timeMs' | 'ord'>, b: Pick<Trade, 'timeMs' | 'ord'>) =>
  a.timeMs - b.timeMs || a.ord - b.ord;

// ── Window ──────────────────────────────────────────────────────────────────────────────────

export interface ObsWindow {
  /** observation_start: the moment the star signal was proven usable (never the crawl time). */
  startMs: number;
  /** Exactly startMs + 168 h; the window is [startMs, endMs). */
  endMs: number;
  /** The minute containing the start (partial unless the start is on a whole minute). */
  startMinuteMs: number;
  /** Minutes touching the window are [startMinuteMs, endMinuteExclusiveMs). */
  endMinuteExclusiveMs: number;
  /** 10 080 when the start is on a whole minute, else 10 081 (the first and last are partial). */
  minutes: number;
  /** The last minute, when the end cuts it (trades from its start up to, not at, endMs). */
  partialEndMinuteMs: number | null;
}

export function observationWindow(start: Date): ObsWindow {
  const startMs = start.getTime();
  const endMs = startMs + WINDOW_MS;
  const startMinuteMs = floorMinute(startMs);
  const endMinuteExclusiveMs = ceilMinute(endMs);
  return {
    startMs,
    endMs,
    startMinuteMs,
    endMinuteExclusiveMs,
    minutes: (endMinuteExclusiveMs - startMinuteMs) / MINUTE_MS,
    partialEndMinuteMs: endMs % MINUTE_MS === 0 ? null : floorMinute(endMs),
  };
}

/** Bars by open time (one per minute; a later duplicate is dropped). */
export function barMap(bars: readonly Bar[]): Map<number, Bar> {
  const m = new Map<number, Bar>();
  for (const b of bars) if (!m.has(b.openMs)) m.set(b.openMs, b);
  return m;
}

/** Why a minute has no candle: answered without one, not fetched (yet), failed, or delisted. */
export function gapStateAt(minuteMs: number, s: PairSync): GapState | 'FUTURE' {
  if (s.syncedUntilMs !== null && minuteMs < s.syncedUntilMs) return 'NO_BAR';
  if (minuteMs + MINUTE_MS > s.closedNowMs) return 'FUTURE';
  return s.unsupported ? 'PAIR_UNSUPPORTED' : s.lastFetchFailed ? 'FETCH_FAILED' : 'NOT_FETCHED';
}

// ── Reference: the first verified trade at or after the start ──────────────────────────────

export type ReferenceEval =
  | {
      status: 'VERIFIED';
      trade: Trade;
      minuteMs: number;
      /** reference time − observation start (ms). */
      delayMs: number;
      /** Whole minutes after the start verified silent before the reference trade. */
      silentMinutes: number;
      /** The operator's rule (2026-11-25): delayed when at least one whole minute was silent. */
      delayed: boolean;
      /** Other trades of the reference's millisecond (LBank's order picks the first). */
      sameMs: Trade[];
    }
  /** Every minute of [start, end) verified, and none holds a trade. */
  | { status: 'NO_TRADE' }
  /** The search stops at `minuteMs`: no candle yet / a gap, or its trades are not checked. */
  | {
      status: 'PENDING';
      minuteMs: number;
      why: GapState | 'FUTURE' | 'CHECK_PENDING' | Exclude<TradeCheckStatus, 'VERIFIED'>;
      needs: number[];
    };

/**
 * The first LBank Spot trade with time ≥ start and < end. Minutes are walked from the start minute: a
 * zero-volume candle is a verified minute without trades; a traded minute needs its complete trade
 * list (checked against its candle) before its first in-window trade can be the reference, which
 * proves no earlier post-start trade was missed. A missing candle stops the search (never skipped).
 */
export function findReference(
  w: ObsWindow,
  bars: ReadonlyMap<number, Bar>,
  checks: ReadonlyMap<number, MinuteCheck>,
  sync: PairSync,
): ReferenceEval {
  for (let m = w.startMinuteMs; m < w.endMinuteExclusiveMs; m += MINUTE_MS) {
    const bar = bars.get(m);
    if (!bar) return { status: 'PENDING', minuteMs: m, why: gapStateAt(m, sync), needs: [] };
    if (!bar.volume.gt(0)) continue;
    const c = checks.get(m);
    if (!c) return { status: 'PENDING', minuteMs: m, why: 'CHECK_PENDING', needs: [m] };
    if (c.status !== 'VERIFIED')
      return { status: 'PENDING', minuteMs: m, why: c.status, needs: [m] };
    const first = c.trades.find((t) => t.timeMs >= w.startMs && t.timeMs < w.endMs);
    if (!first) continue;
    const silentFrom = ceilMinute(w.startMs);
    const silentMinutes = Math.max(0, (floorMinute(first.timeMs) - silentFrom) / MINUTE_MS);
    return {
      status: 'VERIFIED',
      trade: first,
      minuteMs: m,
      delayMs: first.timeMs - w.startMs,
      silentMinutes,
      delayed: silentMinutes >= 1,
      sameMs: c.trades.filter((t) => t.timeMs === first.timeMs && t.id !== first.id),
    };
  }
  return { status: 'NO_TRADE' };
}

// ── Extremes: highest / lowest verified trades over a range of the trade sequence ─────────

/** A range of the trade sequence: from a trade (inclusive) to a time (exclusive) or a trade (inclusive). */
export interface SeqRange {
  from: Pick<Trade, 'timeMs' | 'ord'>;
  to: { beforeMs: number } | { through: Pick<Trade, 'timeMs' | 'ord'> };
}

export type BlockState =
  GapState | 'FUTURE' | 'CHECK_PENDING' | Exclude<TradeCheckStatus, 'VERIFIED'>;

export interface ExtremeEval {
  kind: 'high' | 'low';
  /** First trade at the extreme price (verified minutes only). */
  best: Trade | null;
  bestMinuteMs: number | null;
  /** No gap, unchecked or unverified minute in the range could hold a more extreme price. */
  proven: boolean;
  /** Minutes whose trades must be checked (or re-checked) next, most promising first. */
  needs: number[];
  /**
   * What keeps it from being proven: `gap` ranges (no candle: [fromMs, toMs)) and single `check`
   * minutes whose trades are not verified yet but whose candle bound could beat the best.
   */
  blocking: Array<{ fromMs: number; toMs: number; kind: 'gap' | 'check'; state: BlockState }>;
  /** Candidate minutes examined in candle order with their verified traded extreme (audit). */
  checked: Array<{ minuteMs: number; candle: string; traded: string | null; check: string }>;
}

const inRange = (t: Pick<Trade, 'timeMs' | 'ord'>, r: SeqRange): boolean =>
  cmpTrade(t, r.from) >= 0 &&
  ('beforeMs' in r.to ? t.timeMs < r.to.beforeMs : cmpTrade(t, r.to.through) <= 0);

/** Never-checked candidate minutes asked for per extreme per evaluation (the job loops). */
const NEEDS_PER_EVAL = 3;

/**
 * The highest (or lowest) trade price in `r`, located with candles and proven with trades: the
 * boundary minutes (the reference's, and the last when the range ends inside it) come from their
 * trade lists only; whole minutes are taken in candle High order (Low for the lowest), each checked
 * against its complete trade list, until no remaining candle could hold a higher (or an equal and
 * earlier) price. A candle whose High was a carried OPEN is passed over once its trades show it.
 * Ties go to the earliest trade.
 */
export function rangeExtreme(
  kind: 'high' | 'low',
  r: SeqRange,
  bars: ReadonlyMap<number, Bar>,
  checks: ReadonlyMap<number, MinuteCheck>,
  sync: PairSync,
): ExtremeEval {
  const better = (a: Trade, b: Trade | null) =>
    !b ||
    (kind === 'high' ? a.price.gt(b.price) : a.price.lt(b.price)) ||
    (a.price.eq(b.price) && cmpTrade(a, b) < 0);
  const bound = (b: Bar) => (kind === 'high' ? b.high : b.low);
  const out: ExtremeEval = {
    kind,
    best: null,
    bestMinuteMs: null,
    proven: false,
    needs: [],
    blocking: [],
    checked: [],
  };
  const take = (trades: readonly Trade[], minuteMs: number) => {
    for (const t of trades)
      if (inRange(t, r) && better(t, out.best)) {
        out.best = t;
        out.bestMinuteMs = minuteMs;
      }
  };
  const fromMinute = floorMinute(r.from.timeMs);
  const lastMinute =
    'beforeMs' in r.to ? floorMinute(r.to.beforeMs - 1) : floorMinute(r.to.through.timeMs);
  const lastIsBoundary = 'through' in r.to || r.to.beforeMs % MINUTE_MS !== 0;
  const boundary =
    lastIsBoundary && lastMinute !== fromMinute ? [fromMinute, lastMinute] : [fromMinute];

  const gapAt = (m: number, state: BlockState) => {
    const last = out.blocking.at(-1);
    if (last?.kind === 'gap' && last.toMs === m && last.state === state) last.toMs = m + MINUTE_MS;
    else out.blocking.push({ fromMs: m, toMs: m + MINUTE_MS, kind: 'gap', state });
  };
  const checkAt = (m: number, state: BlockState) => {
    out.blocking.push({ fromMs: m, toMs: m + MINUTE_MS, kind: 'check', state });
    out.needs.push(m);
  };
  for (const m of boundary) {
    const bar = bars.get(m);
    if (!bar) {
      gapAt(m, gapStateAt(m, sync));
      continue;
    }
    if (!bar.volume.gt(0)) continue;
    const c = checks.get(m);
    if (!c) checkAt(m, 'CHECK_PENDING');
    else if (c.status !== 'VERIFIED') checkAt(m, c.status);
    else take(c.trades, m);
  }

  const firstWhole = fromMinute + MINUTE_MS;
  const endWhole = lastIsBoundary ? lastMinute : lastMinute + MINUTE_MS;
  const candidates: Bar[] = [];
  for (let m = firstWhole; m < endWhole; m += MINUTE_MS) {
    const bar = bars.get(m);
    if (!bar) gapAt(m, gapStateAt(m, sync));
    else if (bar.volume.gt(0)) candidates.push(bar);
  }
  candidates.sort((a, b) =>
    kind === 'high'
      ? b.high.cmp(a.high) || a.openMs - b.openMs
      : a.low.cmp(b.low) || a.openMs - b.openMs,
  );
  let pending = 0;
  for (const bar of candidates) {
    const b = bound(bar);
    if (out.best) {
      const beyond = kind === 'high' ? b.gt(out.best.price) : b.lt(out.best.price);
      // An equal bound only matters in a minute earlier than the current best's (ties: earliest).
      if (!beyond && !(b.eq(out.best.price) && bar.openMs < out.bestMinuteMs!)) break;
    }
    const c = checks.get(bar.openMs);
    if (!c || c.status !== 'VERIFIED') {
      // Its trades are unknown (≤ its bound): it blocks; a failed check is retried by the job.
      checkAt(
        bar.openMs,
        c ? (c.status as Exclude<TradeCheckStatus, 'VERIFIED'>) : 'CHECK_PENDING',
      );
      out.checked.push({
        minuteMs: bar.openMs,
        candle: b.toFixed(),
        traded: null,
        check: c?.status ?? 'PENDING',
      });
      if (!c && ++pending >= NEEDS_PER_EVAL) break;
      continue;
    }
    take(c.trades, bar.openMs);
    const own = c.trades.reduce<Trade | null>(
      (x, t) => (!x || (kind === 'high' ? t.price.gt(x.price) : t.price.lt(x.price)) ? t : x),
      null,
    );
    out.checked.push({
      minuteMs: bar.openMs,
      candle: b.toFixed(),
      traded: own?.price.toFixed() ?? null,
      check: c.status,
    });
  }
  // A checked-out candidate whose bound cannot beat (or tie earlier than) the final best does not
  // block; a minute without a candle always does (no bound).
  out.blocking = out.blocking.filter((x) => {
    if (!out.best || x.kind === 'gap') return true;
    const bar = bars.get(x.fromMs);
    if (!bar) return true;
    const b = bound(bar);
    const beyond = kind === 'high' ? b.gt(out.best.price) : b.lt(out.best.price);
    return beyond || (b.eq(out.best.price) && x.fromMs < out.bestMinuteMs!);
  });
  out.needs = [...new Set(out.needs)].filter((m) =>
    out.blocking.some((x) => x.kind === 'check' && x.fromMs === m),
  );
  out.proven = out.blocking.length === 0;
  return out;
}

/** 100 × (price / reference − 1), exact (80 significant digits); negative for a decline. */
export function pctChange(price: DValue, reference: DValue): DValue {
  return price.div(reference).minus(1).times(100);
}

export function extremesOrder(high: Trade | null, low: Trade | null): ExtremesOrder | null {
  if (!high || !low || high.id === low.id) return null;
  if (high.timeMs === low.timeMs) return 'SAME_MS';
  return high.timeMs < low.timeMs ? 'HIGH_FIRST' : 'LOW_FIRST';
}

// ── Coverage ────────────────────────────────────────────────────────────────────────────────

export interface Gap {
  fromMs: number;
  toMs: number;
  state: GapState;
  detail?: string;
}

export interface Coverage {
  /** Minutes touching the window (10 080 or 10 081). */
  minutesExpected: number;
  /** Exclusive end of the window part the candles have been fetched through. */
  dataThroughMs: number;
  minutesPresent: number;
  minutesTraded: number;
  minutesZeroVolume: number;
  /** Minutes the source answered without a candle. */
  minutesMissing: number;
  /** Every gap so far (closed minutes only), oldest first. */
  gaps: Gap[];
  /** Candles for every minute of the window (the window has ended and nothing is missing). */
  candlesComplete: boolean;
}

export function coverage(w: ObsWindow, bars: ReadonlyMap<number, Bar>, sync: PairSync): Coverage {
  const through = Math.max(
    w.startMinuteMs,
    Math.min(w.endMinuteExclusiveMs, sync.syncedUntilMs ?? w.startMinuteMs),
  );
  const gaps: Gap[] = [];
  const add = (fromMs: number, state: GapState) => {
    const last = gaps.at(-1);
    if (last && last.toMs === fromMs && last.state === state) last.toMs = fromMs + MINUTE_MS;
    else gaps.push({ fromMs, toMs: fromMs + MINUTE_MS, state });
  };
  let present = 0;
  let traded = 0;
  let missing = 0;
  const closedEnd = Math.min(w.endMinuteExclusiveMs, sync.closedNowMs);
  for (let m = w.startMinuteMs; m < Math.max(through, closedEnd); m += MINUTE_MS) {
    const bar = bars.get(m);
    if (bar) {
      present++;
      if (bar.volume.gt(0)) traded++;
      continue;
    }
    const state = gapStateAt(m, sync);
    if (state === 'FUTURE') break;
    if (state === 'NO_BAR') missing++;
    add(m, state);
  }
  return {
    minutesExpected: w.minutes,
    dataThroughMs: through,
    minutesPresent: present,
    minutesTraded: traded,
    minutesZeroVolume: present - traded,
    minutesMissing: missing,
    gaps,
    candlesComplete: through >= w.endMinuteExclusiveMs && missing === 0,
  };
}

/** Where the next candle fetch for one observation must start; null when its window is complete. */
export function neededFromMs(w: ObsWindow, syncedUntilMs: number | null): number | null {
  const from = w.startMinuteMs - SPOT_LOOKBACK_MS;
  if (syncedUntilMs !== null && syncedUntilMs >= w.endMinuteExclusiveMs) return null;
  return syncedUntilMs === null || syncedUntilMs < from ? from : syncedUntilMs;
}

/** Whether a traded candle lies in [start − 1 h, start + 1 h) (trading around the signal). */
export function tradeNearSignal(bars: readonly Bar[], w: ObsWindow): boolean {
  return bars.some(
    (b) =>
      b.openMs >= w.startMs - SPOT_LOOKBACK_MS &&
      b.openMs < w.startMs + SIGNAL_TRADE_WINDOW_MS &&
      b.volume.gt(0),
  );
}

/** Whether a candle exists in the hour before the start minute (the series spans the signal). */
export function barBeforeSignal(bars: readonly Bar[], w: ObsWindow): boolean {
  return bars.some((b) => b.openMs < w.startMinuteMs && b.openMs >= w.startMs - SPOT_LOOKBACK_MS);
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
      lastUpdated: p.lastUpdated,
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

/** Identity check only (a review flag): |reference / CMC price − 1| beyond the limit. */
export function deviatesFromCmc(reference: DValue, cmcPrice: DValue): boolean {
  return reference.div(cmcPrice).minus(1).abs().gt(new D(MAPPING_MAX_PRICE_DEVIATION));
}

// ── Spot / Futures at the signal ────────────────────────────────────────────────────────────

export interface SpotEvidenceInput {
  /** LBank's Spot pairs list fetched within the evidence lag of t0: listed or not; null = no list. */
  listed: boolean | null;
  /** LBank answered "currency pair nonsupport" within the evidence lag of t0. */
  unsupportedNearSignal: boolean;
  /** A candle exists in the hour before the start, and one at the start minute. */
  barBeforeT0: boolean;
  entryBar: boolean;
  /** A traded candle in [start − 1 h, start + 1 h). */
  tradeNearSignal: boolean;
}

export interface ListingDecision {
  status: ListingStatus;
  reasons: string[];
}

/**
 * Whether the LBank Spot pair was available and trading at the signal. Candles are historical
 * evidence: a series with candles before and at the start shows the pair existed then. NO needs
 * LBank's own answer near the signal (or the absence of any candle). Conflicts are UNKNOWN.
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
 * Futures LISTING EVIDENCE around the signal (never proof of tradability at the instant, never a
 * Futures price): a snapshot before the signal (CMC's list, by CMC id) and one after it (LBank's own
 * list). YES = the CMC-listed contract is in LBank's list with 24 h volume (listed in both
 * snapshots); NO = neither snapshot has it; anything else is UNKNOWN. It never blocks a Spot result.
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
  /** Null while the observation start is not established yet. */
  w: ObsWindow | null;
  mapping: MappingStatus;
  mappingReasons: readonly string[];
  spot: ListingDecision;
  reference: ReferenceEval | null;
  highest: ExtremeEval | null;
  lowest: ExtremeEval | null;
  lowBeforeHigh: ExtremeEval | null;
  cov: Coverage | null;
  /** LBank answered "currency pair nonsupport" for this pair. */
  pairUnsupported: boolean;
  fetchError: string | null;
}

export interface StatusDecision {
  status: ObservationStatus;
  terminal: boolean;
  reasons: string[];
}

const blockingReasons = (e: ExtremeEval | null): string[] =>
  !e
    ? []
    : e.blocking.map((b) =>
        b.state === 'NO_BAR'
          ? R.missingBars
          : b.state === 'CHECK_PENDING'
            ? R.verificationPending
            : b.state === 'FETCH_FAILED'
              ? R.fetchError
              : b.state === 'PAIR_UNSUPPORTED'
                ? R.pairUnsupported
                : b.state === 'NOT_FETCHED' || b.state === 'FUTURE'
                  ? R.fetchPending
                  : R.tradesUnverified,
      );

/**
 * ACTIVE while the window runs or its data is still being fetched or verified (provisional values);
 * after the window, FINAL only with a verified reference, candles for every minute and every
 * deciding minute's trades verified; NO_TRADES when the complete window holds no trade; otherwise,
 * once the retries are over (end + 24 h, the same for every gap including the first minutes), PARTIAL
 * (reference verified, coverage incomplete) or UNVERIFIABLE (no provable reference). Mapping, Spot
 * availability and delisting outcomes as before. Futures never decides a status.
 */
export function observationStatus(i: StatusInput): StatusDecision {
  const done = (status: ObservationStatus, reasons: string[]): StatusDecision => ({
    status,
    terminal: true,
    reasons: [...new Set(reasons)],
  });
  const active = (reasons: string[]): StatusDecision => ({
    status: 'ACTIVE',
    terminal: false,
    reasons: [...new Set(reasons)],
  });
  if (i.mapping === 'AMBIGUOUS') return done('MAPPING_AMBIGUOUS', [...i.mappingReasons]);
  if (i.mapping === 'NONE') return done('DATA_UNAVAILABLE', [...i.mappingReasons]);
  if (!i.w) return active([R.timingPending]);
  const pastRetries = i.nowMs > i.w.endMs + FINALIZE_RETRY_MS;
  if (i.mapping === 'PENDING')
    return pastRetries
      ? done('ELIGIBILITY_UNKNOWN', [R.mappingPending])
      : active([R.mappingPending]);
  if (i.spot.status === 'NO') return done('DATA_UNAVAILABLE', [...i.spot.reasons]);

  const extra = [
    ...(i.fetchError ? [R.fetchError] : []),
    ...(i.pairUnsupported ? [R.pairUnsupported] : []),
  ];
  const ended = i.nowMs >= i.w.endMs;
  const ref = i.reference;
  if (!ref || ref.status === 'PENDING') {
    const why = ref?.status === 'PENDING' ? ref.why : 'FUTURE';
    const reasons = [
      R.referencePending,
      ...(why === 'NO_BAR'
        ? [R.missingBars]
        : why === 'FETCH_FAILED'
          ? [R.fetchError]
          : why === 'PAIR_UNSUPPORTED'
            ? [R.pairUnsupported]
            : why === 'CHECK_PENDING'
              ? [R.verificationPending]
              : why === 'NOT_FETCHED' || why === 'FUTURE'
                ? [ended ? R.fetchPending : R.windowOpen]
                : [R.tradesUnverified]),
      ...extra,
    ];
    if (!pastRetries) return active(reasons);
    if (i.pairUnsupported || why === 'PAIR_UNSUPPORTED')
      return done('DATA_UNAVAILABLE', [R.pairUnsupported, R.referenceUnverified]);
    return done('UNVERIFIABLE', [R.referenceUnverified, ...reasons.slice(1), R.fetchIncomplete]);
  }
  if (ref.status === 'NO_TRADE') return done('NO_TRADES', [R.noTrades]);

  const proven = !!i.highest?.proven && !!i.lowest?.proven && !!i.lowBeforeHigh?.proven;
  const complete = !!i.cov?.candlesComplete && proven;
  const gapReasons = [
    ...blockingReasons(i.highest),
    ...blockingReasons(i.lowest),
    ...blockingReasons(i.lowBeforeHigh),
    ...(i.cov && i.cov.minutesMissing > 0 ? [R.missingBars] : []),
  ];
  const spotReasons = i.spot.reasons.filter((r) => r !== R.noTradesNearSignal);
  if (!ended)
    return active([
      R.windowOpen,
      ...spotReasons,
      ...gapReasons.filter((r) => r !== R.fetchPending),
      ...extra,
    ]);
  if (!complete) {
    const reasons = [...spotReasons, ...gapReasons, ...extra];
    if (!pastRetries) return active(reasons.length ? reasons : [R.fetchPending]);
    return done('PARTIAL', [...reasons, R.fetchIncomplete]);
  }
  if (i.spot.status !== 'YES')
    return pastRetries ? done('ELIGIBILITY_UNKNOWN', spotReasons) : active(spotReasons);
  return done('FINAL', spotReasons);
}

// ── Review flags ────────────────────────────────────────────────────────────────────────────

export interface FlagInput {
  reference: ReferenceEval | null;
  highest: ExtremeEval | null;
  lowest: ExtremeEval | null;
  checks: ReadonlyMap<number, MinuteCheck>;
  bars: ReadonlyMap<number, Bar>;
  cmcPrice: DValue;
  mappingSnapshotOld: boolean;
}

/**
 * Review flags (operator decisions 2026-11-25): a delayed reference (≥ 1 whole silent minute), a
 * same-millisecond tie at the reference, an extreme set in a minute with exactly one trade (thin
 * market), the CMC identity deviation and an old mapping snapshot. Flags never change a value or a
 * status and never exclude an observation.
 */
export function reviewFlags(i: FlagInput): { flags: string[]; evidence: Record<string, unknown> } {
  const flags: string[] = [];
  const evidence: Record<string, unknown> = {};
  const ref = i.reference?.status === 'VERIFIED' ? i.reference : null;
  if (ref?.delayed) {
    flags.push(F.referenceDelayed);
    evidence.referenceDelayed = { delayMs: ref.delayMs, silentMinutes: ref.silentMinutes };
  }
  if (ref && ref.sameMs.some((t) => !t.price.eq(ref.trade.price))) {
    flags.push(F.referenceSameMsTie);
    evidence.referenceSameMsTie = ref.sameMs.map((t) => ({
      id: t.id,
      price: t.price.toFixed(),
      ord: t.ord,
    }));
  }
  for (const [e, flag] of [
    [i.highest, F.singleTradeHigh],
    [i.lowest, F.singleTradeLow],
  ] as const) {
    if (!e?.best || e.bestMinuteMs === null) continue;
    const c = i.checks.get(e.bestMinuteMs);
    if (c?.status !== 'VERIFIED' || c.trades.length !== 1) continue;
    flags.push(flag);
    const bar = i.bars.get(e.bestMinuteMs);
    evidence[flag === F.singleTradeHigh ? 'singleTradeHigh' : 'singleTradeLow'] = {
      tradeId: e.best.id,
      time: new Date(e.best.timeMs).toISOString(),
      price: e.best.price.toFixed(),
      qty: e.best.qty.toFixed(),
      quoteValueUsdt: e.best.price.times(e.best.qty).toFixed(),
      minuteTrades: 1,
      minuteVolume: bar?.volume.toFixed() ?? null,
      candle: bar
        ? {
            open: bar.open.toFixed(),
            high: bar.high.toFixed(),
            low: bar.low.toFixed(),
            close: bar.close.toFixed(),
          }
        : null,
    };
  }
  if (ref && deviatesFromCmc(ref.trade.price, i.cmcPrice)) {
    flags.push(F.priceDeviation);
    evidence.priceDeviation = {
      reference: ref.trade.price.toFixed(),
      cmcPrice: i.cmcPrice.toFixed(),
      deviationPct: pctChange(ref.trade.price, i.cmcPrice).toFixed(),
      limitPct: new D(MAPPING_MAX_PRICE_DEVIATION).times(100).toFixed(),
    };
  }
  if (i.mappingSnapshotOld) flags.push(F.mappingSnapshotOld);
  return { flags, evidence };
}

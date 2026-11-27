import { D, type DValue } from '../../common/utils/decimal.js';

import { MAPPING_MAX_PRICE_DEVIATION } from './observation.constants.js';

/**
 * LBank Futures sampled observation (docs/lbank-spot-observation.md § 13, rules
 * `lbank-futures-sampled-1`). Pure functions: no database, no HTTP.
 *
 * Why "sampled" and not "verified" (measured 2026-11-27): LBank's official contract API
 * (`lbkperp.lbank.com/cfd/openApi/v1/pub`) serves no historical Futures trades or candles; its only
 * price source is `marketData`, a snapshot of every contract with the last price, a 24 h turnover and
 * `lastTime`. `lastTime` is the snapshot's refresh time, NOT a trade time (it advanced on all 844
 * contracts within 5 s, also on 107 whose volume and turnover did not change). So a snapshot's
 * `lastPrice` alone may be a trade from before the window. The one provable inference: when the 24 h
 * turnover strictly rose between two consecutive snapshots of a contract, at least one trade happened
 * between them, and the later `lastPrice` is the price of such a trade (the last one before the later
 * snapshot). Its time is known only to lie in that bracket.
 *
 *  - reference = the first bracketed trade whose whole bracket lies in [start, end), only when the
 *    contract was already being sampled at the start (a snapshot at or before it); otherwise the
 *    Futures result is HISTORY_UNAVAILABLE (no source can supply the missing part);
 *  - highest / lowest = the highest / lowest bracketed trade in the window from the reference on:
 *    BOUNDS (the true Futures extremes are at least as extreme), never verified extremes;
 *  - percentages relative to the Futures reference only; never a Spot price, a listing snapshot, a
 *    ticker price without a bracket, or the rolling 24 h high / low (context only, not aligned to the
 *    window).
 * Never FINAL: a window that ended is CLOSED (values as sampled).
 */
export const FUTURES_RULES_VERSION = 'lbank-futures-sampled-1';

export const FUTURES_PRICE_SOURCE =
  'LBank Futures marketData snapshots (REST /cfd/openApi/v1/pub/marketData): bracketed last prices, not a trade list';

export const FUTURES_STATUSES = [
  'PENDING',
  'ACTIVE',
  'CLOSED',
  'NO_REFERENCE',
  'HISTORY_UNAVAILABLE',
  'NO_CONTRACT',
  'MAPPING_AMBIGUOUS',
  'MAPPING_UNKNOWN',
] as const;
export type FuturesStatus = (typeof FUTURES_STATUSES)[number];

export const FUTURES_TERMINAL: readonly FuturesStatus[] = [
  'CLOSED',
  'NO_REFERENCE',
  'HISTORY_UNAVAILABLE',
  'NO_CONTRACT',
  'MAPPING_AMBIGUOUS',
  'MAPPING_UNKNOWN',
];

export const FUTURES_MAPPING_STATUSES = ['PENDING', 'OK', 'AMBIGUOUS', 'NONE', 'UNKNOWN'] as const;
export type FuturesMappingStatus = (typeof FUTURES_MAPPING_STATUSES)[number];

export const FUT_REASON = {
  mappingPending: 'FUTURES_MAPPING_PENDING',
  evidenceMissing: 'FUTURES_EVIDENCE_MISSING',
  listUnknown: 'FUTURES_LIST_UNKNOWN',
  noContract: 'NO_FUTURES_CONTRACT',
  tickerOnly: 'FUTURES_TICKER_ONLY',
  notInLbankList: 'FUTURES_NOT_IN_LBANK_LIST',
  multipleContracts: 'MULTIPLE_FUTURES_CONTRACTS',
  startPending: 'TIMING_PENDING',
  notSampledAtStart: 'FUTURES_NOT_SAMPLED_AT_START',
  referencePending: 'FUTURES_REFERENCE_PENDING',
  windowOpen: 'WINDOW_OPEN',
  noBracketedTrade: 'NO_BRACKETED_FUTURES_TRADE',
  contractMissing: 'CONTRACT_MISSING_FROM_MARKET_DATA',
} as const;

export const FUT_FLAG = {
  /** The Futures reference differs more than MAPPING_MAX_PRICE_DEVIATION from the CMC price (identity check). */
  priceDeviation: 'FUTURES_PRICE_DEVIATION_FROM_CMC',
} as const;

// ── Mapping ─────────────────────────────────────────────────────────────────────────────────

export interface FuturesMappingInput {
  /** The observation's stored Spot/Futures listing evidence (`eligibility_evidence`), or null. */
  evidence: Record<string, unknown> | null;
  /** The coin's ticker (only to detect ticker-only matches, never to map). */
  coinSymbol: string;
}

export interface FuturesMapping {
  status: FuturesMappingStatus;
  contract: string | null;
  reasons: string[];
  evidence: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * The LBank Futures contract of the event's CMC id: CMC's LBank Futures markets list as of the crawl
 * gives the contracts attributed to that CMC id, each pinned by its market URL
 * (`…/futures/<symbol>/`); exactly one, and present in LBank's own contract list read after the
 * signal, maps. A contract matched by ticker alone never maps (CMC attributes e.g. DYDXUSDT to
 * ethDYDX and MONUSDT to MoneyByte, and tickers collide: TSMONUSDT, 1000000BABYDOGEUSDT).
 */
export function mapFuturesContract(i: FuturesMappingInput): FuturesMapping {
  if (!i.evidence)
    return {
      status: 'PENDING',
      contract: null,
      reasons: [FUT_REASON.mappingPending],
      evidence: {},
    };
  const cmc = obj(i.evidence.cmcFutures);
  const lbank = obj(i.evidence.lbankFutures);
  const cmcContracts = strings(cmc?.contracts).map((s) => s.toUpperCase());
  const lbankRows = Array.isArray(lbank?.contracts)
    ? (lbank.contracts as unknown[]).map(obj).filter((r): r is Record<string, unknown> => !!r)
    : [];
  const lbankSymbols = lbankRows
    .map((r) => (typeof r.symbol === 'string' ? r.symbol.toUpperCase() : null))
    .filter((s): s is string => !!s);
  const evidence = {
    rule: 'one CMC LBank Futures market attributed to this CMC id (URL-pinned contract) that LBank lists',
    cmcContracts,
    cmcListStatus: cmc?.status ?? null,
    cmcListFetchedAt: cmc?.fetchedAt ?? null,
    lbankListFetchedAt: lbank?.fetchedAt ?? null,
    lbankRelevant: lbankSymbols,
  };
  const out = (status: FuturesMappingStatus, contract: string | null, reasons: string[]) => ({
    status,
    contract,
    reasons,
    evidence,
  });
  if (!cmc || !lbank || lbank.notFetched || lbank.error)
    return out('UNKNOWN', null, [FUT_REASON.evidenceMissing]);
  if (cmc.status === 'UNKNOWN') return out('UNKNOWN', null, [FUT_REASON.listUnknown]);
  if (cmcContracts.length > 1) return out('AMBIGUOUS', null, [FUT_REASON.multipleContracts]);
  if (cmcContracts.length === 1) {
    const c = cmcContracts[0]!;
    return lbankSymbols.includes(c)
      ? out('OK', c, [])
      : out('AMBIGUOUS', null, [FUT_REASON.notInLbankList]);
  }
  const ticker = i.coinSymbol.toUpperCase();
  const tickerHit = lbankRows.some(
    (r) => typeof r.base === 'string' && r.base.toUpperCase() === ticker,
  );
  return tickerHit
    ? out('AMBIGUOUS', null, [FUT_REASON.tickerOnly])
    : out('NONE', null, [FUT_REASON.noContract]);
}

// ── Sampling fold ───────────────────────────────────────────────────────────────────────────

export interface FuturesSample {
  /** The snapshot's own time (`lastTime`, whole seconds, as ms). */
  serverMs: number;
  /** When the response was received (provenance). */
  fetchedMs: number;
  lastPrice: DValue;
  turnover: DValue;
}

export interface BracketedTrade {
  price: string;
  /** The trade happened strictly after this (the previous snapshot's time, ≥ start). */
  afterMs: number;
  /** …and strictly before this (this snapshot's second + 1 s). */
  beforeMs: number;
  /** The snapshot that carried it. */
  sampleMs: number;
}

/** Running state of one observation's fold (stored as JSON; exact decimals as text). */
export interface FuturesFoldState {
  /** The last snapshot at or before the start (proves sampling ran at the start). */
  anchorMs: number | null;
  /** The last folded snapshot. */
  prev: { serverMs: number; turnover: string } | null;
  /** A snapshot after the start arrived with no anchor: the start was not sampled. */
  unsampledStart: boolean;
  /** First snapshot after the start (sampling coverage). */
  firstAfterStartMs: number | null;
  samplesInWindow: number;
  bracketedInWindow: number;
  /** Longest interval inside [start, end) without a snapshot (clipped to the window). */
  maxGapMs: number;
  reference: BracketedTrade | null;
  highest: BracketedTrade | null;
  lowest: BracketedTrade | null;
  /** Latest folded snapshot time (exclusive data-through = serverMs + 1 s). */
  throughMs: number | null;
}

export const emptyFold = (): FuturesFoldState => ({
  anchorMs: null,
  prev: null,
  unsampledStart: false,
  firstAfterStartMs: null,
  samplesInWindow: 0,
  bracketedInWindow: 0,
  maxGapMs: 0,
  reference: null,
  highest: null,
  lowest: null,
  throughMs: null,
});

const SECOND_MS = 1_000;

/**
 * Folds snapshots (ascending, each later than the state's last one) into the state. Deterministic:
 * folding the full series from `emptyFold()` gives the same state as folding it in pieces.
 */
export function foldFutures(
  state: FuturesFoldState,
  samples: readonly FuturesSample[],
  w: { startMs: number; endMs: number },
): FuturesFoldState {
  const s: FuturesFoldState = {
    ...state,
    reference: state.reference && { ...state.reference },
    highest: state.highest && { ...state.highest },
    lowest: state.lowest && { ...state.lowest },
  };
  for (const x of samples) {
    if (s.prev && x.serverMs <= s.prev.serverMs) continue;
    if (x.serverMs <= w.startMs) {
      s.anchorMs = x.serverMs;
      s.prev = { serverMs: x.serverMs, turnover: x.turnover.toFixed() };
      s.throughMs = x.serverMs;
      continue;
    }
    if (s.anchorMs === null) s.unsampledStart = true;
    if (s.firstAfterStartMs === null) s.firstAfterStartMs = x.serverMs;
    // Sampling coverage inside the window (descriptive; no threshold).
    const from = Math.max(s.prev ? s.prev.serverMs : w.startMs, w.startMs);
    const to = Math.min(x.serverMs, w.endMs);
    if (to > from) s.maxGapMs = Math.max(s.maxGapMs, to - from);
    if (x.serverMs < w.endMs) s.samplesInWindow++;
    const prev = s.prev;
    const bracket =
      !s.unsampledStart &&
      prev !== null &&
      prev.serverMs >= w.startMs &&
      x.serverMs + SECOND_MS <= w.endMs &&
      x.turnover.gt(prev.turnover);
    if (bracket) {
      const t: BracketedTrade = {
        price: x.lastPrice.toFixed(),
        afterMs: prev.serverMs,
        beforeMs: x.serverMs + SECOND_MS,
        sampleMs: x.serverMs,
      };
      s.bracketedInWindow++;
      if (!s.reference) s.reference = t;
      // Ties keep the earlier trade.
      if (!s.highest || x.lastPrice.gt(s.highest.price)) s.highest = t;
      if (!s.lowest || x.lastPrice.lt(s.lowest.price)) s.lowest = t;
    }
    s.prev = { serverMs: x.serverMs, turnover: x.turnover.toFixed() };
    s.throughMs = x.serverMs;
  }
  return s;
}

// ── Status and values ───────────────────────────────────────────────────────────────────────

export interface FuturesEvalInput {
  nowMs: number;
  mapping: FuturesMapping;
  window: { startMs: number; endMs: number } | null;
  fold: FuturesFoldState;
  /** Time of the latest successful marketData snapshot of any contract (sampler progress). */
  lastPollServerMs: number | null;
  /** Whether the contract was in that latest snapshot. */
  contractInLastPoll: boolean;
  /** CMC USD price at detection (identity check only). */
  cmcPriceUsd: DValue | null;
}

export interface FuturesEvaluation {
  status: FuturesStatus;
  terminal: boolean;
  reasons: string[];
  flags: string[];
  highestReturnPct: DValue | null;
  lowestReturnPct: DValue | null;
}

const pct = (x: string, ref: string) => new D(x).div(ref).minus(1).times(100);

export function evaluateFutures(i: FuturesEvalInput): FuturesEvaluation {
  const none = (
    status: FuturesStatus,
    terminal: boolean,
    reasons: string[],
  ): FuturesEvaluation => ({
    status,
    terminal,
    reasons,
    flags: [],
    highestReturnPct: null,
    lowestReturnPct: null,
  });
  const m = i.mapping;
  if (m.status === 'PENDING') return none('PENDING', false, m.reasons);
  if (m.status === 'NONE') return none('NO_CONTRACT', true, m.reasons);
  if (m.status === 'AMBIGUOUS') return none('MAPPING_AMBIGUOUS', true, m.reasons);
  if (m.status === 'UNKNOWN') return none('MAPPING_UNKNOWN', true, m.reasons);
  if (!i.window) return none('PENDING', false, [FUT_REASON.startPending]);
  const f = i.fold;
  if (f.unsampledStart) return none('HISTORY_UNAVAILABLE', true, [FUT_REASON.notSampledAtStart]);
  const ref = f.reference;
  const flags: string[] = [];
  if (
    ref &&
    i.cmcPriceUsd &&
    i.cmcPriceUsd.gt(0) &&
    new D(ref.price).minus(i.cmcPriceUsd).abs().div(i.cmcPriceUsd).gt(MAPPING_MAX_PRICE_DEVIATION)
  )
    flags.push(FUT_FLAG.priceDeviation);
  const values = {
    flags,
    highestReturnPct: ref && f.highest ? pct(f.highest.price, ref.price) : null,
    lowestReturnPct: ref && f.lowest ? pct(f.lowest.price, ref.price) : null,
  };
  // The window is over for the sampler once a snapshot at or after its end was read: for this
  // contract (folded), or for all contracts while this one was missing from it.
  const over =
    (f.throughMs !== null && f.throughMs >= i.window.endMs) ||
    (i.lastPollServerMs !== null && i.lastPollServerMs >= i.window.endMs && !i.contractInLastPoll);
  if (!over) {
    // No snapshot at or before the start yet: the first one decides whether the start was sampled.
    const reasons: string[] = [FUT_REASON.windowOpen];
    if (!ref) reasons.push(FUT_REASON.referencePending);
    return { status: 'ACTIVE', terminal: false, reasons, ...values };
  }
  const reasons: string[] = [];
  if (!(f.throughMs !== null && f.throughMs >= i.window.endMs))
    reasons.push(FUT_REASON.contractMissing);
  if (!ref)
    return { ...none('NO_REFERENCE', true, [...reasons, FUT_REASON.noBracketedTrade]), flags };
  return { status: 'CLOSED', terminal: true, reasons, ...values };
}

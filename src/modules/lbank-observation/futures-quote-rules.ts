import { D, type DValue } from '../../common/utils/decimal.js';

import type { FuturesMapping, FuturesStatus } from './futures-rules.js';
import { MAPPING_MAX_PRICE_DEVIATION } from './observation.constants.js';

/**
 * LBank Futures observed-quote method (rules `lbank-futures-quote-1`, docs § 13, ADR-0011 addendum
 * 2026-11-27). Pure functions: no database, no HTTP.
 *
 * Operator decision 2026-11-27: the Futures reference is the FIRST valid `lastPrice` our system
 * observes for the event's contract from an API request STARTED at or after the actionable start
 * (the Review Queue publication), with the delay measured to the RESPONSE RECEIPT. A request is fired
 * as soon as the queue is published; nothing waits for a sampler tick, a turnover rise or a price
 * change. It is an observed API quote: LBank's `marketData` gives no trade time (`lastTime` is the
 * snapshot's refresh time), so the price may come from a trade before the signal. It is never "the
 * first Futures trade after the signal" and never an order's execution price.
 *
 *  - eligible observation = a successful response whose request was sent at or after the start and
 *    whose response arrived before the end (exclusive), carrying a positive `lastPrice` for the
 *    contract; a pre-signal snapshot, a response to a request sent before the start, or an old
 *    snapshot of another event never qualifies;
 *  - reference = the eligible observation received first (ties: earlier send, then lower request id);
 *  - highest / lowest observed = the highest / lowest eligible observed `lastPrice` in the window (the
 *    reference included): observed quotes at our sampling times, not verified trades, not bounds of
 *    the trade path; LBank's rolling 24 h high / low is never used;
 *  - 24 h turnover and volume are context only.
 */
export const FUTURES_QUOTE_RULES_VERSION = 'lbank-futures-quote-1';
export const FUTURES_QUOTE_LABEL = 'First Futures price observed after signal';
export const FUTURES_QUOTE_PRICE_SOURCE =
  'LBank Futures marketData lastPrice (REST /cfd/openApi/v1/pub/marketData) observed by our requests; no trade time in the response';

/** How the request that produced a quote was triggered. */
export const QUOTE_SOURCES = ['PUBLICATION', 'RETRY', 'TICK'] as const;
export type QuoteSource = (typeof QUOTE_SOURCES)[number];

export const QUOTE_REASON = {
  quotePending: 'FUTURES_QUOTE_PENDING',
  noQuote: 'NO_FUTURES_QUOTE_IN_WINDOW',
  mappingPending: 'FUTURES_MAPPING_PENDING',
  listUnknown: 'FUTURES_LIST_UNKNOWN',
  noContract: 'NO_FUTURES_CONTRACT',
  tickerOnly: 'FUTURES_TICKER_ONLY',
  notInLbankList: 'FUTURES_NOT_IN_LBANK_LIST',
  multipleContracts: 'MULTIPLE_FUTURES_CONTRACTS',
  startPending: 'TIMING_PENDING',
  windowOpen: 'WINDOW_OPEN',
} as const;

export interface QuoteWindow {
  startMs: number;
  endMs: number;
}

/** One of our observations of the contract: a request's timing and the price it returned. */
export interface QuoteObservation {
  pollId: string;
  source: QuoteSource;
  /** When the request was actually sent; null = not recorded (requests before 2026-11-27's fix). */
  requestStartedMs: number | null;
  responseMs: number;
  /** The contract's `lastPrice` in the response; null = contract missing or price invalid. */
  price: DValue | null;
}

/** Sent at or after the start, received before the end, with a valid price. */
export function isEligible(o: QuoteObservation, w: QuoteWindow): boolean {
  return (
    o.requestStartedMs !== null &&
    o.requestStartedMs >= w.startMs &&
    o.responseMs < w.endMs &&
    o.price !== null &&
    o.price.gt(0)
  );
}

const byReceipt = (a: QuoteObservation, b: QuoteObservation) =>
  a.responseMs - b.responseMs ||
  (a.requestStartedMs ?? 0) - (b.requestStartedMs ?? 0) ||
  (BigInt(a.pollId) < BigInt(b.pollId) ? -1 : BigInt(a.pollId) > BigInt(b.pollId) ? 1 : 0);

/** The reference: the eligible observation received first (independent of processing order). */
export function earliestEligible(
  obs: readonly QuoteObservation[],
  w: QuoteWindow,
): QuoteObservation | null {
  return [...obs].filter((o) => isEligible(o, w)).sort(byReceipt)[0] ?? null;
}

/** Whether `candidate` must replace `current` as the reference (only an earlier receipt does). */
export function replacesReference(
  current: QuoteObservation | null,
  candidate: QuoteObservation,
): boolean {
  return !current || byReceipt(candidate, current) < 0;
}

// ── Mapping at publication ─────────────────────────────────────────────────────────────────

export interface QuoteMappingInput {
  /** CMC's LBank Futures list as of the crawl (by CMC id, URL-pinned contracts). */
  cmc: { status: string; contracts: readonly string[]; fetchedAt: string | null } | null;
  /** Contract symbols present in an eligible `marketData` response; null = none received yet. */
  lbankSymbols: ReadonlySet<string> | null;
  /** The poll whose response supplied `lbankSymbols` (provenance). */
  lbankPollId: string | null;
  coinSymbol: string;
}

/**
 * The event's contract, decided as soon as the queue is published: exactly one contract that CMC
 * attributes to the CMC id (by market URL, list as of the crawl) and that LBank's eligible
 * `marketData` response contains. A ticker match alone never maps. Without an eligible response yet
 * the decision waits (PENDING) — nothing is assigned to a guessed contract.
 */
export function mapAtPublication(i: QuoteMappingInput): FuturesMapping {
  const cmcContracts = (i.cmc?.contracts ?? []).map((c) => c.toUpperCase());
  const evidence = {
    rule: 'one CMC LBank Futures market attributed to this CMC id (URL-pinned, list as of the crawl) present in LBank marketData',
    cmcContracts,
    cmcListStatus: i.cmc?.status ?? null,
    cmcListFetchedAt: i.cmc?.fetchedAt ?? null,
    lbankPollId: i.lbankPollId,
  };
  const out = (status: FuturesMapping['status'], contract: string | null, reasons: string[]) => ({
    status,
    contract,
    reasons,
    evidence,
  });
  if (!i.cmc || i.cmc.status === 'UNKNOWN') return out('UNKNOWN', null, [QUOTE_REASON.listUnknown]);
  if (cmcContracts.length > 1) return out('AMBIGUOUS', null, [QUOTE_REASON.multipleContracts]);
  if (!i.lbankSymbols) return out('PENDING', null, [QUOTE_REASON.mappingPending]);
  // Missing from this response (absent, or a row without a valid price): decided again with the
  // next response; it ends MAPPING_UNKNOWN if never present before the window ends.
  if (cmcContracts.length === 1)
    return i.lbankSymbols.has(cmcContracts[0]!)
      ? out('OK', cmcContracts[0]!, [])
      : out('PENDING', null, [QUOTE_REASON.notInLbankList]);
  return i.lbankSymbols.has(`${i.coinSymbol.toUpperCase()}USDT`)
    ? out('AMBIGUOUS', null, [QUOTE_REASON.tickerOnly])
    : out('NONE', null, [QUOTE_REASON.noContract]);
}

// ── Window values and status ───────────────────────────────────────────────────────────────

export interface ObservedExtreme {
  price: string;
  observedMs: number;
  pollId: string;
}

export interface QuoteWindowValues {
  count: number;
  highest: ObservedExtreme | null;
  lowest: ObservedExtreme | null;
  /** Longest interval inside the window without an eligible observation (from the start on). */
  maxGapMs: number;
  /** Latest eligible observation's receipt. */
  throughMs: number | null;
}

/** Highest / lowest observed `lastPrice` among the eligible observations (first one on ties). */
export function windowValues(obs: readonly QuoteObservation[], w: QuoteWindow): QuoteWindowValues {
  const el = obs.filter((o) => isEligible(o, w)).sort(byReceipt);
  let highest: ObservedExtreme | null = null;
  let lowest: ObservedExtreme | null = null;
  let maxGapMs = 0;
  let prev = w.startMs;
  for (const o of el) {
    maxGapMs = Math.max(maxGapMs, o.responseMs - prev);
    prev = o.responseMs;
    const x = { price: o.price!.toFixed(), observedMs: o.responseMs, pollId: o.pollId };
    if (!highest || o.price!.gt(highest.price)) highest = x;
    if (!lowest || o.price!.lt(lowest.price)) lowest = x;
  }
  return { count: el.length, highest, lowest, maxGapMs, throughMs: el.at(-1)?.responseMs ?? null };
}

export interface QuoteEvalInput {
  mapping: FuturesMapping;
  window: QuoteWindow | null;
  reference: QuoteObservation | null;
  values: QuoteWindowValues;
  /** Send time of our latest request of any kind (decides that no eligible response can follow). */
  latestRequestStartedMs: number | null;
  cmcPriceUsd: DValue | null;
}

export interface QuoteEvaluation {
  status: FuturesStatus;
  terminal: boolean;
  reasons: string[];
  flags: string[];
  highestReturnPct: DValue | null;
  lowestReturnPct: DValue | null;
}

const pct = (x: string, ref: DValue) => new D(x).div(ref).minus(1).times(100);

export function evaluateQuote(i: QuoteEvalInput): QuoteEvaluation {
  const none = (status: FuturesStatus, terminal: boolean, reasons: string[]): QuoteEvaluation => ({
    status,
    terminal,
    reasons,
    flags: [],
    highestReturnPct: null,
    lowestReturnPct: null,
  });
  const m = i.mapping;
  if (m.status === 'NONE') return none('NO_CONTRACT', true, m.reasons);
  if (m.status === 'AMBIGUOUS') return none('MAPPING_AMBIGUOUS', true, m.reasons);
  if (m.status === 'UNKNOWN') return none('MAPPING_UNKNOWN', true, m.reasons);
  if (!i.window) return none('PENDING', false, [QUOTE_REASON.startPending]);
  // No eligible response can still arrive once we sent a request at or after the end.
  const over = i.latestRequestStartedMs !== null && i.latestRequestStartedMs >= i.window.endMs;
  if (m.status === 'PENDING') return none(over ? 'MAPPING_UNKNOWN' : 'PENDING', over, m.reasons);
  const ref = i.reference;
  if (!ref)
    return none(over ? 'NO_REFERENCE' : 'PENDING', over, [
      over ? QUOTE_REASON.noQuote : QUOTE_REASON.quotePending,
    ]);
  const refPrice = ref.price!;
  const flags: string[] = [];
  if (
    i.cmcPriceUsd &&
    i.cmcPriceUsd.gt(0) &&
    refPrice.minus(i.cmcPriceUsd).abs().div(i.cmcPriceUsd).gt(MAPPING_MAX_PRICE_DEVIATION)
  )
    flags.push('FUTURES_PRICE_DEVIATION_FROM_CMC');
  // The reference is itself an eligible observation, so it bounds both observed extremes.
  const hi =
    i.values.highest && new D(i.values.highest.price).gt(refPrice)
      ? i.values.highest.price
      : refPrice.toFixed();
  const lo =
    i.values.lowest && new D(i.values.lowest.price).lt(refPrice)
      ? i.values.lowest.price
      : refPrice.toFixed();
  return {
    status: over ? 'CLOSED' : 'ACTIVE',
    terminal: over,
    reasons: over ? [] : [QUOTE_REASON.windowOpen],
    flags,
    highestReturnPct: pct(hi, refPrice),
    lowestReturnPct: pct(lo, refPrice),
  };
}

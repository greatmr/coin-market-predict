import type { LbankStatus } from "./constants.js";

/**
 * LBank Spot pair status per CMC asset (PDF p.9, p.10). Pure: the caller supplies the crawl,
 * listing history and human decisions as of the batch being scanned.
 */

export interface VenuePair {
  /** CMC exchange slug, e.g. "lbank". */
  exchange: string;
  exchangeName: string;
  /**
   * CMC's id of this exchange market. Unique per market, unlike the pair name: two different
   * assets can share a ticker ("XYZ/USDT") on one exchange. Absent in rows stored before 2026-11-05.
   */
  marketId?: number | null;
  marketPair: string;
  category: string;
  baseSymbol: string;
  /** CMC id the crawler maps the base asset to (the crawler's own identity mapping). */
  baseCurrencyId: number | null;
  quoteSymbol: string;
  quoteCurrencyId: number | null;
  /** Exact source text. */
  volumeUsd: string | null;
  volumePercent: string | null;
  priceUsd: string | null;
  lastUpdated: string | null;
  marketUrl: string | null;
  /** Trading status when the feed provides one (e.g. "TRADING"); null = no proof. */
  tradingStatus: string | null;
  type: string | null;
  flags: string[];
}

export interface LbankCrawlView {
  id: string;
  status: "COMPLETE" | "INCOMPLETE" | "FAILED";
  finishedAt: Date;
  pairs: VenuePair[];
}

export type DecisionKind = "VERIFIED_TRADABLE" | "NOT_TRADABLE" | "MAPPING_CONFIRMED" | "MAPPING_REJECTED";

export interface VenueDecisionView {
  id: string;
  marketPair: string | null;
  decision: DecisionKind;
  decidedAt: Date;
  reviewer: string;
  source: "review" | "overrides_file";
}

export interface PairHistoryView {
  /** Latest ABSENT event per market pair at or before the crawl. */
  lastAbsentAt: ReadonlyMap<string, Date>;
  /** Market pairs that had a LISTED event for this asset at or before the crawl. */
  everListed: ReadonlySet<string>;
}

export type PairMapping = "OK" | "CONFIRMED" | "AMBIGUOUS" | "REJECTED";
export type PairTrading = "TRADING" | "UNVERIFIED" | "NOT_TRADABLE";

export interface ResolvedPair {
  marketPair: string;
  baseSymbol: string;
  quoteSymbol: string;
  mapping: PairMapping;
  trading: PairTrading;
  /** feed = a trading-status field; listing = present in CMC's LBank Spot markets list (operator decision D1); reviewer = a human decision. */
  tradingSource: "feed" | "listing" | "reviewer" | null;
  volumeUsd: string | null;
  lastUpdated: string | null;
  marketUrl: string | null;
  evidence: string[];
  decisionIds: string[];
}

export interface MappingTaskDraft {
  marketPair: string;
  kind: "SYMBOL_MISMATCH" | "TICKER_MULTIPLE_IDS";
  evidence: Record<string, unknown>;
}

export interface LbankResolution {
  status: LbankStatus;
  reason: string | null;
  pairs: ResolvedPair[];
  tasks: MappingTaskDraft[];
}

export interface LbankContext {
  crawl: LbankCrawlView | null;
  fresh: boolean;
  pairsById: ReadonlyMap<number, VenuePair[]>;
  /** Upper-case LBank base symbol → CMC ids it is mapped to in this crawl. */
  tickerIds: ReadonlyMap<string, ReadonlySet<number>>;
  /**
   * Operator decision D1 (2026-11-05): a pair present in CMC's LBank Spot markets list counts as
   * tradable without a separate human check. False = every listed pair needs a reviewer's
   * VERIFIED_TRADABLE (assumption A7, LBANK_REQUIRE_MANUAL_VERIFICATION=true).
   */
  listingIsTradable: boolean;
}

/** `maxAgeMs`: how far the list's fetch time may be from the scan's as-of time before it is stale. */
export function buildLbankContext(crawl: LbankCrawlView | null, asOf: Date, maxAgeMs: number, opts: { listingIsTradable?: boolean } = {}): LbankContext {
  const pairsById = new Map<number, VenuePair[]>();
  const tickerIds = new Map<string, Set<number>>();
  for (const p of crawl?.pairs ?? []) {
    if (p.category !== "spot" || p.baseCurrencyId === null) continue;
    pairsById.set(p.baseCurrencyId, [...(pairsById.get(p.baseCurrencyId) ?? []), p]);
    const t = p.baseSymbol.toUpperCase();
    if (!tickerIds.has(t)) tickerIds.set(t, new Set());
    tickerIds.get(t)!.add(p.baseCurrencyId);
  }
  const fresh = !!crawl && Math.abs(asOf.getTime() - crawl.finishedAt.getTime()) <= maxAgeMs;
  return { crawl, fresh, pairsById, tickerIds, listingIsTradable: opts.listingIsTradable ?? false };
}

function latest(decisions: VenueDecisionView[], pair: string | null, kinds: DecisionKind[]): VenueDecisionView | null {
  let best: VenueDecisionView | null = null;
  for (const d of decisions) {
    if (d.marketPair !== pair || !kinds.includes(d.decision)) continue;
    if (!best || d.decidedAt > best.decidedAt) best = d;
  }
  return best;
}

export function resolveLbank(cmcId: number, symbol: string, ctx: LbankContext, decisions: VenueDecisionView[], history: PairHistoryView): LbankResolution {
  if (!ctx.crawl) return { status: "UNKNOWN", reason: "LBANK_FEED_MISSING", pairs: [], tasks: [] };
  if (ctx.crawl.status !== "COMPLETE") return { status: "UNKNOWN", reason: ctx.crawl.status === "FAILED" ? "LBANK_FEED_FAILED" : "LBANK_FEED_INCOMPLETE", pairs: [], tasks: [] };
  if (!ctx.fresh) return { status: "UNKNOWN", reason: "LBANK_FEED_STALE", pairs: [], tasks: [] };

  const tasks: MappingTaskDraft[] = [];
  const pairs: ResolvedPair[] = (ctx.pairsById.get(cmcId) ?? []).map((p) => {
    const evidence: string[] = [];
    const decisionIds: string[] = [];
    const ticker = p.baseSymbol.toUpperCase();
    const symbolMismatch = ticker !== symbol.toUpperCase();
    const ids = ctx.tickerIds.get(ticker);
    const multiId = !!ids && ids.size > 1;
    if (symbolMismatch) evidence.push(`LBank base ${p.baseSymbol} ≠ CMC symbol ${symbol}`);
    if (multiId) evidence.push(`LBank base ${p.baseSymbol} is mapped to CMC ids ${[...ids!].sort((a, b) => a - b).join(", ")}`);

    const mapDecision = latest(decisions, p.marketPair, ["MAPPING_CONFIRMED", "MAPPING_REJECTED"]);
    let mapping: PairMapping = symbolMismatch || multiId ? "AMBIGUOUS" : "OK";
    if (mapDecision) decisionIds.push(mapDecision.id);
    if (mapDecision?.decision === "MAPPING_REJECTED") mapping = "REJECTED";
    else if (mapping === "AMBIGUOUS" && mapDecision?.decision === "MAPPING_CONFIRMED") mapping = "CONFIRMED";
    if (mapping === "AMBIGUOUS") {
      if (symbolMismatch) tasks.push({ marketPair: p.marketPair, kind: "SYMBOL_MISMATCH", evidence: { cmcId, cmcSymbol: symbol, lbankBaseSymbol: p.baseSymbol, baseCurrencyId: p.baseCurrencyId, crawlId: ctx.crawl!.id } });
      if (multiId) tasks.push({ marketPair: p.marketPair, kind: "TICKER_MULTIPLE_IDS", evidence: { lbankBaseSymbol: p.baseSymbol, cmcIds: [...ids!].sort((a, b) => a - b), crawlId: ctx.crawl!.id } });
    }

    // Trading status: a reviewer's NOT_TRADABLE wins; then feed proof; then presence in the LBank
    // Spot markets list when the operator accepts it (D1); then a reviewer's verification made
    // after the pair's last disappearance (A9); otherwise unverified.
    const tradeDecision = latest(decisions, p.marketPair, ["VERIFIED_TRADABLE", "NOT_TRADABLE"]);
    if (tradeDecision) decisionIds.push(tradeDecision.id);
    const absentAt = history.lastAbsentAt.get(p.marketPair) ?? null;
    let trading: PairTrading = "UNVERIFIED";
    let tradingSource: ResolvedPair["tradingSource"] = null;
    const feed = p.tradingStatus?.toUpperCase() ?? null;
    if (tradeDecision?.decision === "NOT_TRADABLE") {
      trading = "NOT_TRADABLE";
      tradingSource = "reviewer";
    } else if (feed) {
      trading = feed === "TRADING" ? "TRADING" : "NOT_TRADABLE";
      tradingSource = "feed";
      evidence.push(`feed trading status ${feed}`);
    } else if (ctx.listingIsTradable) {
      trading = "TRADING";
      tradingSource = "listing";
      evidence.push(`listed in CMC's LBank Spot markets (list fetched ${ctx.crawl!.finishedAt.toISOString()})`);
    } else if (tradeDecision?.decision === "VERIFIED_TRADABLE") {
      if (!absentAt || tradeDecision.decidedAt > absentAt) {
        trading = "TRADING";
        tradingSource = "reviewer";
      } else evidence.push(`verification of ${tradeDecision.decidedAt.toISOString()} voided: pair absent at ${absentAt.toISOString()}`);
    } else evidence.push("feed gives no trading-status proof");

    return { marketPair: p.marketPair, baseSymbol: p.baseSymbol, quoteSymbol: p.quoteSymbol, mapping, trading, tradingSource, volumeUsd: p.volumeUsd, lastUpdated: p.lastUpdated, marketUrl: p.marketUrl, evidence, decisionIds };
  });

  const attributed = pairs.filter((p) => p.mapping === "OK" || p.mapping === "CONFIRMED");
  if (attributed.some((p) => p.trading === "TRADING")) return { status: "VERIFIED", reason: null, pairs, tasks };
  if (pairs.some((p) => p.mapping === "AMBIGUOUS")) return { status: "UNKNOWN", reason: "AMBIGUOUS_MAPPING", pairs, tasks };
  if (attributed.some((p) => p.trading === "UNVERIFIED")) return { status: "PAIR_LISTED_UNVERIFIED", reason: "NO_TRADING_STATUS_PROOF", pairs, tasks };
  if (attributed.length) return { status: "NOT_TRADABLE", reason: "REVIEWER_OR_FEED_NOT_TRADABLE", pairs, tasks };

  const assetDecision = latest(decisions, null, ["NOT_TRADABLE"]);
  if (assetDecision) return { status: "NOT_TRADABLE", reason: "REVIEWER_NO_TRADABLE_PAIR", pairs, tasks };
  const rejected = new Set(pairs.filter((p) => p.mapping === "REJECTED").map((p) => p.marketPair));
  const rejectedEver = new Set(decisions.filter((d) => d.decision === "MAPPING_REJECTED" && d.marketPair).map((d) => d.marketPair!));
  const disappeared = [...history.everListed].some((mp) => !rejected.has(mp) && !rejectedEver.has(mp));
  if (disappeared) return { status: "UNKNOWN", reason: "PAIR_DISAPPEARED", pairs, tasks };
  return { status: "NOT_LISTED", reason: null, pairs, tasks };
}

// Payloads of the coin page (GET /api/assets/:cmcId/trace, /snapshots, /agent; POST /reviews,
// /venue-decisions). JSON: dates are ISO strings, exact decimals are strings. Shapes follow
// read-model.service.ts (assetTrace), read-model/tradingview.ts, strategy/tier1/lbank.ts,
// strategy/tier2/review-rules.ts and agent/agent.service.ts.
import type { Iso, Num } from '../../types/api';

export type PassStatus = 'YES' | 'NO' | 'N/A';

/** strategy/tier1/lbank.ts ResolvedPair */
export interface LbankPair {
  marketPair: string;
  baseSymbol: string;
  quoteSymbol: string;
  mapping: string;
  trading: string;
  tradingSource: 'feed' | 'listing' | 'reviewer' | null;
  volumeUsd: string | null;
  lastUpdated: string | null;
  marketUrl: string | null;
  evidence: string[];
  decisionIds: string[];
}

/** The scan_result row of this coin and batch. */
export interface TraceRecord {
  batchId: string;
  cmcId: number;
  symbol: string;
  name: string;
  slug: string | null;
  rank: number | null;
  dateAdded: Iso | null;
  ageDays: string | null;
  priceUsd: string | null;
  capUsd: string | null;
  volume24hUsd: string | null;
  observedAt: Iso | null;
  crawledAt: Iso;
  currentStatus: string;
  currentReason: string | null;
  currentVmc: string | null;
  stars: number;
  eligibilityStatus: string;
  eligibilityReasons: string[];
  assetClass: string;
  classSource: string | null;
  lbankStatus: string;
  lbankReason: string | null;
  lbankPairs: LbankPair[];
  venueReview: string;
  venueFlags: string[];
  flags: string[];
  inQueue: boolean;
  queueOrder: number | null;
  weightedPassPoints: number | null;
  scoreComplete: boolean | null;
  weightedStrength: string | null;
  computedAt: Iso;
  rulesetVersion: string;
}

export interface TraceBatch {
  id: string;
  slotTime: Iso;
  isLive: boolean;
  status: string;
  crawledAt: Iso;
}

export interface DailyRow {
  dateUtc: string;
  daysAgo: number;
  revisionId: number | null;
  revision: number | null;
  volumeUsd: string | null;
  marketCapUsd: string | null;
  closeUsd: string | null;
  vmc: string | null;
  valid: boolean | null;
  invalidReasons: string[];
  sourceCloseAt: Iso | null;
  retrievedAt: Iso | null;
  source: string | null;
  revisedSinceScan: boolean;
}

export interface TraceWindow {
  days: number;
  role: string;
  dates: string[];
  mean: string | null;
  reason: string | null;
  formula: string;
  comparison: string | null;
  /** null for the 14-day window (context only). */
  pass: { multiple: string | null; status: PassStatus; reason: string | null } | null;
}

/** strategy/tier2/review-rules.ts NormalizedPlan */
export interface ReviewPlan {
  entryPrice: string | null;
  entryTime: string | null;
  stopPrice: string | null;
  stopPct: string | null;
  targets: { price: string | null; allocationPct: string | null; rationale: string | null }[];
  deadline: string | null;
  notes: string | null;
}

export interface ReviewValidation {
  errors: string[];
  warnings: string[];
  planStatus: string | null;
}

export interface ReviewRow {
  id: string;
  cmcId: number;
  batchId: string;
  revision: number;
  reviewer: string;
  reviewedAt: Iso;
  venueDecision: string;
  venueNote: string | null;
  eventDay: string;
  lbankPair: string | null;
  chartExchange: string | null;
  chartSymbol: string | null;
  chartQuote: string | null;
  chartUrl: string | null;
  chartTimezone: string | null;
  chartProxyReason: string | null;
  rangeLow: string | null;
  chartHistory: string | null;
  priorPumpResponse: string | null;
  candleState: string | null;
  marketRegime: string | null;
  finalDecision: string;
  rationale: string | null;
  plan: ReviewPlan | null;
  planStatus: string | null;
  validation: { errors: string[]; warnings: string[] } | null;
}

export interface VenueDecisionRow {
  id: string;
  decision: string;
  marketPair: string | null;
  reviewer: string;
  note: string | null;
  decidedAt: Iso;
  exchange: string;
}

export interface MappingTask {
  id: string;
  marketPair: string;
  kind: string;
  status: string;
}

export interface LbankCrawl {
  id: string;
  status: string;
  finishedAt: Iso | null;
  fetchedCount: number | null;
  expectedCount: number | null;
}

/** scan_result.diagnostics.venue (tier1/venue-summary.ts). */
export interface VenueSummary {
  pairsUsed: number;
  expectedCount: number | null;
  observedAt: Iso | null;
  exchanges: { name: string; volumeUsd: Num | null }[];
  flags?: string[];
}

export interface MetadataChange {
  id?: string;
  observedAt: Iso;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** read-model/tradingview.ts ChartCandidate */
export type ChartSource = 'cmc_venue' | 'lbank_perpetual' | 'ticker_index';
export interface ChartCandidate {
  symbol: string;
  exchange: string;
  base: string;
  quote: string;
  source: ChartSource;
  label: string;
  note: string;
  volumeUsd: string | null;
}

/** GET /api/assets/:cmcId/trace */
/** How the trace's record was obtained (ReadModelService.assetTrace, D4). */
export interface TraceEvaluation {
  /** stored: the batch's Review Queue row; on_request: computed now from the batch's stored inputs; earlier_stored: the coin's last stored row (no observation in the latest batch). */
  mode: 'stored' | 'on_request' | 'earlier_stored';
  stored: boolean;
  latestBatchId: string | null;
  note: string | null;
}

export interface AssetTrace {
  record: TraceRecord;
  batch: TraceBatch;
  evaluation?: TraceEvaluation;
  current: { label: string; formula: string; status: string; reason: string | null };
  daily: { asOfDate: string; latestCompletedDate: string; used: DailyRow[] };
  windows: TraceWindow[];
  eligibility: {
    status: string;
    reasons: string[];
    assetClass: string;
    classSource: string | null;
  };
  lbank: {
    status: string;
    reason: string | null;
    pairs: LbankPair[];
    crawl: LbankCrawl | null;
    decisions: VenueDecisionRow[];
    tasks: MappingTask[];
  };
  venues: { review: string; flags: string[]; summary: VenueSummary | null };
  reviews: ReviewRow[];
  metadataChanges?: MetadataChange[];
  chart?: { candidates: ChartCandidate[] };
}

/** GET /api/assets/:cmcId/snapshots?hours= */
export interface SnapshotRow {
  slotTime: Iso;
  price: string | null;
  volumeRolling24h: string | null;
  qualityFlags: string[] | null;
}
export interface Snapshots {
  cmcId: number;
  snapshots: SnapshotRow[];
}

/** POST /api/reviews */
export interface ReviewSaved {
  review: { revision: number; [key: string]: unknown };
  validation: ReviewValidation;
}

/* ---------- Agent (agent/agent.service.ts forCoin / analysisJson) ---------- */

export interface AgentFactor {
  point: string;
  evidence: string;
}
export interface AgentOutput {
  outlook: string;
  confidence: string;
  headline: string;
  mindset: string;
  strategyFit: string;
  bullishFactors: AgentFactor[];
  bearishFactors: AgentFactor[];
  risks: string[];
  dataGaps: string[];
  watchNext: string[];
  candleState: string;
  marketRegime: string;
}
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number;
  durationApiMs: number | null;
  models: string[];
  refusalFallback: boolean;
}
export interface AgentAnalysis {
  id: string;
  cmcId: number;
  symbol: string;
  name: string;
  batchId: string;
  isLive: boolean;
  requestedBy: string;
  requestedAt: Iso;
  finishedAt: Iso | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | string;
  countsTowardLimit: boolean;
  model: string;
  fallbackModel: string | null;
  effort: string;
  promptVersion: string;
  rulesetVersion: string;
  outlook: string | null;
  confidence: string | null;
  output: AgentOutput | null;
  guardrailNotes: string[];
  toolCalls: { name: string; denied?: boolean }[];
  usage: AgentUsage | null;
  errorKind: string | null;
  errorMessage: string | null;
}
export interface AgentQuota {
  max: number;
  windowHours: number;
  used: number;
  remaining: number;
  nextFreeAt: Iso | null;
}
export interface AgentStatus {
  available: boolean;
  reason: string | null;
  model: string;
  effort: string;
  horizonHours: number;
  timeoutSeconds: number;
  quota: AgentQuota;
  running: {
    id: string;
    cmcId: number;
    symbol: string;
    requestedBy: string;
    requestedAt: Iso;
  } | null;
  analyses: AgentAnalysis[];
}

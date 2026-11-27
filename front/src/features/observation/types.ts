// API shapes of the LBank Spot Price Observation (GET /api/observations…, rules lbank-spot-obs-2).
// Prices and percentages are exact decimal strings from the server; they are formatted for display
// only. Every price is an LBank Spot trade; the CMC price is context.

export type ObsStatus =
  | 'ACTIVE'
  | 'FINAL'
  | 'PARTIAL'
  | 'DATA_UNAVAILABLE'
  | 'MAPPING_AMBIGUOUS'
  | 'ELIGIBILITY_UNKNOWN'
  | 'NO_TRADES'
  | 'UNVERIFIABLE';

export type Eligibility =
  | 'PENDING'
  | 'SPOT_AND_FUTURES'
  | 'SPOT_ONLY'
  | 'SPOT_FUTURES_UNKNOWN'
  | 'SPOT_UNAVAILABLE'
  | 'SPOT_UNKNOWN'
  | 'MAPPING_AMBIGUOUS';

export type ObsSort =
  | 'detected'
  | 'start'
  | 'stars'
  | 'points'
  | 'highest'
  | 'lowest'
  | 'referenceDelay'
  | 'coverage'
  | 'symbol'
  | 'futuresHighest'
  | 'futuresLowest';

export type FuturesStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'CLOSED'
  | 'NO_REFERENCE'
  | 'HISTORY_UNAVAILABLE'
  | 'NO_CONTRACT'
  | 'MAPPING_AMBIGUOUS'
  | 'MAPPING_UNKNOWN';

/** A Futures trade known only by its price and a time bracket (strictly after / before). */
export interface Bracketed {
  price: string;
  after: string;
  before: string;
}

/** An observed Futures quote: our request's times and the price LBank returned (no trade time). */
export interface ObservedQuote {
  price: string;
  /** Response received (the displayed delay ends here). */
  observedAt: string;
  requestQueuedAt: string | null;
  requestStartedAt: string;
  storedAt: string;
  delayMs: number;
  publicationToRequestMs: number;
  requestToResponseMs: number;
  source: 'PUBLICATION' | 'RETRY' | 'TICK' | string;
  failedAttemptsBefore: number;
  /** LBank's snapshot refresh time: NOT the time of the underlying trade. */
  lbankSnapshotAt: string | null;
  endpoint: string;
  pollId: string;
}

/** The Futures side: observed quotes (lbank-futures-quote-1) or the older turnover-bracket method. */
export interface FuturesSampled {
  rulesVersion: string;
  method: 'OBSERVED_QUOTE' | 'LEGACY_TURNOVER_BRACKET';
  status: FuturesStatus;
  provisional: boolean;
  mapping: 'PENDING' | 'OK' | 'AMBIGUOUS' | 'NONE' | 'UNKNOWN' | string;
  contract: string | null;
  reasons: string[];
  flags: string[];
  quote: ObservedQuote | null;
  /** Legacy method only. */
  reference: Bracketed | null;
  highest: {
    price: string;
    pct: string | null;
    observedAt?: string;
    after?: string;
    before?: string;
  } | null;
  lowest: {
    price: string;
    pct: string | null;
    observedAt?: string;
    after?: string;
    before?: string;
  } | null;
  postFixQuote: ObservedQuote | null;
  /** Read once after the first quote: a later book, never the book at the quote's moment. */
  book: {
    ok: boolean;
    error: string | null;
    bestBid: string | null;
    bestAsk: string | null;
    requestStartedAt: string | null;
    responseReceivedAt: string;
    /** Book response − first quote response (ms). */
    afterQuoteMs: number | null;
  } | null;
  samplesInWindow: number;
  bracketedInWindow: number;
  /** Longest interval without an observation, in `throughBasis` time. */
  maxGapMs: number;
  /** The time base of the through time and the longest gap (each method keeps its own). */
  throughBasis: TimeBasis;
  /** Observed-quote method: our latest eligible response's receipt. */
  observedThrough: string | null;
  /** Old method: LBank's snapshot refresh time of the latest folded snapshot (not a trade time). */
  lbankSnapshotThrough: string | null;
  evidenceClass: FuturesEvidenceClass;
  immediateEntry: boolean;
  lastUpdateAt: string | null;
  valuesChangedAt: string | null;
  finalizedAt: string | null;
}

export type TimeBasis = 'OUR_RESPONSE_RECEIVED' | 'LBANK_SNAPSHOT_TIME';

export type FuturesEvidenceClass =
  | 'IMMEDIATE_QUOTE'
  | 'TICK_QUOTE'
  | 'QUOTE_PENDING'
  | 'NO_QUOTE'
  | 'NO_CONTRACT'
  | 'LEGACY_BEFORE_COLLECTION'
  | 'LEGACY_FIRST_RESPONSE_RETAINED'
  | 'LEGACY_FIRST_RESPONSE_LOST'
  | 'LEGACY_UNRESOLVED';

/** The pair's latest price in the Spot price request fired at publication (indicative only). */
export interface IndicativeSpotQuote {
  price: string;
  pair: string;
  requestQueuedAt: string;
  requestStartedAt: string;
  observedAt: string;
  storedAt: string;
  delayMs: number;
  /** LBank's response time: not a trade time. */
  lbankResponseAt: string | null;
  requestId: string;
  endpoint: string;
}

/** The two publication requests side by side (initiated together, never simultaneous). */
export interface PublicationQuotes {
  futuresSource: string;
  futuresRequestStartedAt: string;
  spotRequestStartedAt: string;
  sentDifferenceMs: number;
  futuresObservedAt: string;
  spotObservedAt: string;
  receivedDifferenceMs: number;
  queuedTogether: boolean;
}

/** How far each venue's data reaches, in its own time base, and how far apart. */
export interface CoverageTimes {
  spotDataThrough: string | null;
  spotLastFetchAt: string | null;
  futuresThrough: string | null;
  futuresBasis: TimeBasis | null;
  differenceMs: number | null;
  differs: boolean;
}

export interface Gap {
  from: string;
  to: string;
  state: string;
  detail?: string;
}

export interface Extreme {
  price: string;
  at: string;
  tradeId: string;
  pct: string | null;
}

export interface ObservationRow {
  id: string;
  eventId: string;
  cmcId: number;
  symbol: string;
  name: string;
  slug: string | null;
  stars: number;
  points: number | null;
  scoreComplete: boolean | null;
  /** t0: the hourly CMC crawl start (identity and routing only). */
  crawlAt: string;
  cmcQuoteAt: string;
  cmcPriceUsd: string;
  /** [start, end): from the proven moment the signal was usable, exactly 168 h. */
  window: {
    start: string;
    end: string;
    source: 'SCAN_COMMIT' | 'EVENT_COMMIT' | 'JOB_FIRST_SEEN' | string;
    uncertain: boolean;
    afterCrawlMs: number;
  } | null;
  pair: { symbol: string | null; quote: string | null; mapping: string };
  eligibility: Eligibility;
  eligibilityLabel: string;
  spot: string;
  spotTrading: string | null;
  futures: string;
  reference: {
    status: 'PENDING' | 'VERIFIED' | 'NO_TRADE' | 'UNVERIFIED' | string;
    tradeId: string | null;
    at: string | null;
    price: string | null;
    qty: string | null;
    delayMs: number | null;
    delayed: boolean | null;
  };
  highest: Extreme | null;
  lowest: Extreme | null;
  lowBeforeHighest: { price: string; at: string; tradeId: string | null } | null;
  order: 'HIGH_FIRST' | 'LOW_FIRST' | 'SAME_MS' | null;
  extremesProven: boolean;
  coverage: {
    minutesExpected: number | null;
    minutesPresent: number;
    minutesTraded: number;
    minutesMissing: number;
    complete: boolean;
    gaps: Gap[];
  };
  freshness: {
    dataThrough: string | null;
    lastSourceFetchAt: string | null;
    lastFetchAttemptAt: string | null;
    lastFetchError: string | null;
    retryUntil: string | null;
    lastRecomputedAt: string | null;
  };
  flags: string[];
  status: ObsStatus;
  provisional: boolean;
  reasons: string[];
  finalizedAt: string | null;
  rulesVersion: string;
  resultVersion: number;
  coinEvents: number;
  overlapping: number;
  isLive: boolean;
  /** Futures listing evidence is `futures`; the Futures result is this. */
  futuresSampled: FuturesSampled | null;
  /** Indicative Spot quote at publication: never the Spot reference, a return or an extreme. */
  spotIndicative: IndicativeSpotQuote | null;
  publicationQuotes: PublicationQuotes | null;
  coverageTimes: CoverageTimes;
}

export interface Timeline {
  crawlAt: string;
  pipelineRunId: string | null;
  pipelineStages: Array<{
    stage: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    attempts: number;
  }>;
  publishedAt: string | null;
  eventCommittedAt: string | null;
  startMinuteReadableAt: string | null;
  referenceTradeAt: string | null;
  marketDelayMs: number | null;
  referenceCheck: {
    minute: string;
    status: string;
    firstCheckedAt: string;
    checkedAt: string;
    attempts: number;
    stampedWithRunStart: boolean;
    run: { id: string; trigger: string; startedAt: string; finishedAt: string | null } | null;
  } | null;
  processingDelayMs: number | null;
}

export interface PublicationRequest {
  requestId: string;
  queuedAt: string | null;
  startedAt: string | null;
  receivedAt: string | null;
  storedAt: string | null;
  ok: boolean;
  error: string | null;
}

/** GET /api/observations/:id */
export interface ObservationDetail extends ObservationRow {
  displayedRulesVersion: string;
  /** Every request fired for this event's publication, both venues, with their real times. */
  publicationRequests: {
    futures: Array<PublicationRequest & { trigger: string; attempt: number }>;
    spot: Array<
      PublicationRequest & {
        endpoint: string;
        lbankResponseAt: string | null;
        pairs: number;
        failedAttempts: Array<{ sentAt: string | null; failedAt: string; message: string }>;
      }
    >;
  };
  event: {
    detectedUtcDate: string;
    crawlAt: string;
    cmcQuoteAt: string;
    sourceBatchId: string;
    slotTime: string;
    createdAt: string;
    rank: number | null;
    rulesetVersion: string;
  };
  timeline: Timeline;
  futuresAudit: {
    failedAttempts?: Array<{
      requestId: string;
      trigger: string;
      attempt: number;
      requestStartedAt: string | null;
      failedAt: string;
      error: string | null;
    }>;
    legacyReplay?: {
      firstEligibleRequestId: string;
      firstEligibleRequestStartedAt: string | null;
      firstEligibleRequestSentNotBefore: string;
      firstEligibleResponseAt: string;
      contractRowRetained: boolean;
      retainedPrice: string | null;
      correctedReferenceEstablished: boolean;
      reconstructedDelayMs: number | null;
      note: string;
    } | null;
  } | null;
  futuresEvidence: {
    priceSource: string;
    mappingEvidence: Record<string, unknown>;
    fold: Record<string, unknown>;
    createdAt: string;
    lastSample: Record<string, unknown> | null;
  } | null;
  actionableEvidence: Record<string, unknown> | null;
  referenceEvidence: Record<string, unknown> | null;
  extremesEvidence: Record<string, ExtremeEvidence | null> | null;
  flagsEvidence: Record<string, unknown> | null;
  evidenceSha256: string | null;
  mappingEvidence: Record<string, unknown> | null;
  eligibilityEvidence: Record<string, unknown> | null;
  pairState: Record<string, unknown> | null;
  legacyV1: Record<string, unknown> | null;
  rulesChanges: Array<{
    from: string;
    to: string;
    fromStatus: string;
    fromResultVersion: number;
    fromFinalizedAt: string | null;
    changedAt: string;
    reason: string;
  }>;
  results: Array<{
    version: number;
    status: string;
    rulesVersion: string;
    highestReturnPct: string | null;
    lowestReturnPct: string | null;
    referencePrice: string | null;
    observationStart: string | null;
    flags: string[];
    v1MaxRisePct: string | null;
    v1MaxDropPct: string | null;
    evidenceSha256: string | null;
    computedAt: string;
    reasons: string[];
  }>;
}

export interface ExtremeEvidence {
  best: { id: string; time: string; price: string; qty: string } | null;
  minute: string | null;
  proven: boolean;
  checked: Array<{ minute: string; candle: string; traded: string | null; check: string }>;
  blocking: Array<{ from: string; to: string; kind: string; state: string }>;
}

/** GET /api/observations/:id/overlaps */
export interface ObservationOverlaps {
  observation: ObservationRow;
  coin: { cmcId: number; events: number };
  overlaps: (ObservationRow & {
    relation: 'same_utc_day' | 'earlier' | 'later';
    overlapStart: string;
    overlapEnd: string;
    overlapHours: string;
  })[];
}

/** GET /api/storage (health:read) */
export interface StorageReport {
  measuredAt: string;
  databaseBytes: number;
  tables: {
    name: string;
    totalBytes: number;
    tableBytes: number;
    indexBytes: number;
    rowsEstimate: number | null;
  }[];
  retention: { detailDays: number; snapshotDays: number; candleDays: number };
}

export interface ObservationPage {
  rows: ObservationRow[];
  total: number;
}

export interface StatsJson {
  n: number;
  mean: string | null;
  median: string | null;
  p25: string | null;
  p75: string | null;
  min: string | null;
  max: string | null;
}

export interface Count {
  events: number;
  coins: number;
}

export interface ObservationSummary {
  priceSource: string;
  rulesVersion: string;
  windowHours: number;
  retryHours: number;
  cutover: {
    providerId: string;
    cutoverAt: string | null;
    setAt: string | null;
    setBy: string | null;
    note: string | null;
    passed: boolean;
  };
  lastRun: {
    id: string;
    trigger: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    notes: string[];
    fetchedNewData: boolean | null;
    candlesStored: number | null;
    tradeMinutesChecked: number | null;
  } | null;
  lastSuccessfulRunAt: string | null;
  freshness: {
    activeObservations: number;
    oldestOpenDataThrough: string | null;
    oldestOpenLagMs: number | null;
    lastSourceFetchAt: string | null;
    pairsWithFetchErrors: number;
    observationsAwaitingVerification: number;
  };
  summary: {
    rulesVersion: string;
    total: Count;
    byStatus: Record<ObsStatus, Count>;
    byEligibility: Record<Eligibility, Count>;
    final: Count & {
      highest: StatsJson;
      lowest: StatsJson;
      byStars: Array<Count & { key: string; highest: StatsJson; lowest: StatsJson }>;
      byEligibility: Array<
        Count & { key: string; label: string; highest: StatsJson; lowest: StatsJson }
      >;
      flagged: { singleTrade: Count; delayedReference: Count };
    };
    provisional: Count;
    partial: Count;
    noTrades: Count;
    unverifiable: Count;
    unmeasured: Count;
    correlation: {
      coinsWithSeveralEvents: number;
      eventsOfThoseCoins: number;
      overlappingPairs: number;
    };
  };
  futures: {
    rulesVersion: string;
    priceSource: string;
    byStatus: Partial<Record<FuturesStatus, number>>;
    byMethod: {
      OBSERVED_QUOTE: Partial<Record<FuturesStatus, number>>;
      LEGACY_TURNOVER_BRACKET: Partial<Record<FuturesStatus, number>>;
    };
    lastPoll: {
      fetchedAt: string;
      serverAt: string | null;
      ok: boolean;
      error: string | null;
    } | null;
    /** Old and new methods apart: only IMMEDIATE_QUOTE is an immediate Futures entry. */
    byEvidence: Record<FuturesEvidenceClass, number>;
    immediateEntries: number;
    freshness: {
      openObservedRows: number;
      oldestOpenObservedThrough: string | null;
      latestObservedThrough: string | null;
      lastValuesChangeAt: string | null;
    };
  };
  deletions: ObservationDeletion[];
}

/** Operator-approved deletions of earlier cohorts: removed from every count. */
export interface ObservationDeletion {
  id: string;
  throughBatchId: string;
  throughCrawledAt: string;
  deletedAt: string;
  batches: number;
  events: number;
  reason: string;
}

/** GET /api/observations/version: cheap change tokens, polled every 30 s. */
export interface ObservationVersion {
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunFinishedAt: string | null;
  lastChangeAt: string | null;
  observations: number;
  futures: {
    lastValuesChangeAt: string | null;
    rows: number;
    lastQuoteStoredAt: string | null;
    lastBookStoredAt: string | null;
    lastSpotQuoteStoredAt: string | null;
    oldestOpenObservedThrough: string | null;
    lastPoll: { fetchedAt: string; ok: boolean } | null;
  };
  /** Moves with Spot job runs and stored Spot changes (reload list and summary). */
  spotToken: string;
  /** Moves only when a displayed Futures value or a publication quote changes (reload the rows). */
  futuresToken: string;
}

export interface LegacyStatus {
  state: 'active' | 'closing' | 'retired';
  cutoverAt: string | null;
  events: number;
  terminal: number;
  pending: number;
  pendingUntil: string | null;
  closures: { FINAL: number; INCOMPLETE: number; DATA_UNAVAILABLE: number };
  reasons: Record<string, number>;
  why: string;
}

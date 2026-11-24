// API shapes of the LBank Spot Price Observation (GET /api/observations…). Prices and percentages
// are exact decimal strings from the server; they are formatted for display only.

export type ObsStatus =
  'ACTIVE' | 'FINAL' | 'PARTIAL' | 'DATA_UNAVAILABLE' | 'MAPPING_AMBIGUOUS' | 'ELIGIBILITY_UNKNOWN';

export type Eligibility =
  | 'PENDING'
  | 'SPOT_AND_FUTURES'
  | 'SPOT_ONLY'
  | 'SPOT_FUTURES_UNKNOWN'
  | 'SPOT_UNAVAILABLE'
  | 'SPOT_UNKNOWN'
  | 'MAPPING_AMBIGUOUS';

export type ObsSort =
  'detected' | 'stars' | 'points' | 'rise' | 'drop' | 'entryDelay' | 'coverage' | 'symbol';

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
  signalAt: string;
  windowEnd: string;
  cmcPriceUsd: string;
  pair: { symbol: string | null; quote: string | null; mapping: string };
  eligibility: Eligibility;
  eligibilityLabel: string;
  spot: string;
  spotTrading: string | null;
  futures: string;
  entry: {
    at: string;
    price: string;
    delayMs: number;
    stale: boolean | null;
    lastTradeAt: string | null;
  } | null;
  high: { price: string; barAt: string } | null;
  low: { price: string; barAt: string } | null;
  maxRisePct: string | null;
  maxDropPct: string | null;
  lowBeforeHigh: { price: string; barAt: string } | null;
  extremeOrder: 'HIGH_FIRST' | 'LOW_FIRST' | 'SAME_BAR' | null;
  coverage: {
    expectedBars: number;
    coveredBars: number;
    missingBars: number;
    tradedBars: number;
    observedThrough: string | null;
    complete: boolean;
    startUnobservedMs: number;
    boundaryUnobservedMs: number;
    missingRanges: Array<[string, string]>;
  };
  status: ObsStatus;
  provisional: boolean;
  reasons: string[];
  lastUpdateAt: string | null;
  finalizedAt: string | null;
  rulesVersion: string;
  resultVersion: number;
  coinEvents: number;
  overlapping: number;
  isLive: boolean;
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
  maxEntryDelayMs: number;
  maxEntryStalenessMs: number;
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
  } | null;
  lastSuccessfulRunAt: string | null;
  summary: {
    total: Count;
    byStatus: Record<ObsStatus, Count>;
    byEligibility: Record<Eligibility, Count>;
    final: Count & {
      rise: StatsJson;
      drop: StatsJson;
      byStars: Array<Count & { key: string; rise: StatsJson; drop: StatsJson }>;
      byEligibility: Array<
        Count & { key: string; label: string; rise: StatsJson; drop: StatsJson }
      >;
    };
    provisional: Count;
    unmeasured: Count;
    correlation: {
      coinsWithSeveralEvents: number;
      eventsOfThoseCoins: number;
      overlappingPairs: number;
    };
  };
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

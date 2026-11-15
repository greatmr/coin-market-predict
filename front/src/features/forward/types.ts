// Payloads of /api/forward (ForwardReadService in src/modules/forward-test/forward-read.service.ts).
// Money and percentage values are exact decimal strings.
import type { Iso } from '../../types/api';

export type ForwardStatus = 'OPEN' | 'TRACKING' | 'AWAITING_FINAL_DAY' | 'FINAL' | 'INCOMPLETE';
export type PassStatus = 'YES' | 'NO' | 'N/A';
export type EventView = 'active' | 'final' | 'incomplete' | 'all';
/** Result of an event's latest High check (forward_event.last_check_status). */
export type CheckStatus =
  'NOT_CHECKED' | 'NEW_RECORD' | 'UNCHANGED' | 'DATA_UNAVAILABLE' | 'RETRIEVAL_ERROR';
/** `sort` of GET /api/forward/events. */
export type EventSort =
  'detected' | 'return' | 'stars' | 'points' | 'multiple3d' | 'multiple7d' | 'multiple30d';
/** `result` of GET /api/forward/events. */
export type ResultFilter = CheckStatus | 'CONFIRMED' | 'DAY0_UNCONFIRMED';

export interface ForwardOutcome {
  resultVersion: number;
  revisionReason: string | null;
  rulesVersion: string;
  coverageStatus: string;
  peakKind: 'EXACT' | 'LOWER_BOUND' | 'NONE' | string;
  peakHighUsd: string | null;
  peakAt: Iso | null;
  peakDate: string | null;
  peakTimePrecision: string | null;
  peakPeriodStart: Iso | null;
  peakPeriodEnd: Iso | null;
  peakReturnPct: string | null;
  extensionPeakFlag: 'TRUE' | 'FALSE' | 'UNKNOWN' | string | null;
  day0State: string;
  expectedDays: number;
  completedDays: number;
  coveredDays: number;
  missingDates: string[];
  invalidDates: string[];
  reasons: string[];
  computedAt: Iso;
  finalizedAt: Iso | null;
}

export interface ForwardEventRow {
  eventId: string;
  cmcId: number;
  symbol: string;
  name: string;
  slug: string | null;
  isLive: boolean;
  detectedAt: Iso;
  detectedUtcDate: string;
  detectionHourUtc: number;
  starCount: number;
  referencePriceUsd: string;
  sourceUpdatedAt: Iso;
  sourceBatchId: string;
  rank: number | null;
  pass3d: PassStatus;
  pass7d: PassStatus;
  pass30d: PassStatus;
  multiple3d: string | null;
  multiple7d: string | null;
  multiple30d: string | null;
  passPattern: string;
  weightedPassPoints: number | null;
  scoreComplete: boolean | null;
  weightedStrength: string | null;
  rankingRulesetVersion: string | null;
  currentVmc: string | null;
  lbankPairs: string[];
  rulesetVersion: string;
  deadline168h: Iso;
  evaluationEnd: Iso;
  effectiveHorizonHours: string;
  status: ForwardStatus;
  qualityFlags: string[];
  resultVersion: number;
  lastUpdateAt: Iso | null;
  finalizedAt: Iso | null;
  outcome: ForwardOutcome | null;
  assetEventCount: number;
  overlappingEventIds: string[];
  check: {
    status: CheckStatus;
    lastCheckAt: Iso | null;
    lastSuccessAt: Iso | null;
    /** YYYY-MM-DD (UTC): every closed day up to here has a usable daily High. */
    checkedThrough: string | null;
    note: string | null;
  };
  /** day: 0 (UTC date of identification) … 7 (UTC date of identification + 168 h). */
  window: {
    day: number;
    lastDay: number;
    closed: boolean;
    closedDays: number;
    checkedDays: number;
  };
  /** The identification day's daily High; DAY0_UNPROVEN never enters a result. */
  day0: {
    highUsd: string | null;
    timeHigh: Iso | null;
    eligibility: 'FULL_DAY' | 'DAY0_POST_SIGNAL' | 'DAY0_UNPROVEN' | 'INVALID';
    reason: string | null;
    changePct: string | null;
  } | null;
}

/** GET /api/forward/events/:id/overlaps */
export interface ForwardOverlaps {
  event: OverlapEvent;
  rule: string;
  overlaps: (OverlapEvent & {
    relation: 'same_utc_day' | 'earlier' | 'later';
    overlapStart: Iso;
    overlapEnd: Iso;
    overlapHours: string;
    peakReturnPct: string | null;
    peakKind: string | null;
  })[];
}
export interface OverlapEvent {
  eventId: string;
  symbol: string;
  name: string;
  starCount: number;
  detectedAt: Iso;
  detectedUtcDate: string;
  referencePriceUsd: string;
  evaluationEnd: Iso;
  status: ForwardStatus;
}

/** GET /api/forward/events */
export interface ForwardEventsPage {
  total: number;
  offset: number;
  rows: ForwardEventRow[];
}

export interface ReturnStats {
  n: number;
  mean: string | null;
  median: string | null;
  p25: string | null;
  p75: string | null;
  min: string | null;
  max: string | null;
}

export interface CohortGroup {
  dimension: 'stars' | 'pass_pattern' | 'points_band';
  group: string;
  events: number;
  distinctAssets: number;
  final: number;
  incomplete: number;
  pending: number;
  /** FINAL + INCOMPLETE. */
  completed: number;
  byStatus: Record<ForwardStatus, number>;
  confirmedHigh: number;
  awaitingCheck: number;
  day0Unconfirmed: number;
  finalReturns: ReturnStats;
  /** Provisional (lower-bound) returns of active events with a confirmed High. */
  activeReturns: ReturnStats;
  returnDistribution: { label: string; count: number }[];
  detectionHourUtc: number[];
  horizonHours: ReturnStats & { bins: { label: string; count: number }[] };
  correlation: {
    assetsWithMultipleEvents: number;
    eventsOnRepeatedAssets: number;
    sameAssetOverlaps: number;
    detectionDates: number;
    datesWithMultipleEvents: number;
    maxEventsPerDate: number;
  };
}

export interface UpdateChecks {
  checked: number;
  newRecord: number;
  unchanged: number;
  dataUnavailable: number;
  errors: number;
  notDue: number;
}

/** A daily High update; also GET /api/forward/update-runs/:id while it runs. */
export interface UpdateRun {
  id: string;
  trigger: string;
  updateDate: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed' | string;
  startedAt: Iso;
  finishedAt: Iso | null;
  notes: string[];
  error: string | null;
  progress: {
    phase: 'starting' | 'fetching' | 'evaluating' | 'done' | string;
    processed: number;
    total: number;
  } | null;
  /** Per-event check results (null for runs recorded before they were counted). */
  checks: UpdateChecks | null;
}

/** GET /api/forward */
export interface ForwardSummary {
  providerId: string;
  providerName: string;
  isLive: boolean | null;
  rulesVersion: string;
  horizon: { hours: number; rule: string; days: string };
  notice: string;
  counts: {
    events: number;
    watchlistAssets: number;
    byStatus: Record<ForwardStatus, number>;
    triggerRuns: number;
  };
  lastTrigger: {
    batchId: string;
    triggeredAt: Iso;
    queueStatus: string;
    queueRows: number;
    created: number;
    ignored: number;
    rejected: number;
  } | null;
  lastUpdate: UpdateRun | null;
  lastSuccessfulUpdate: UpdateRun | null;
  coverage: {
    completedDays: number;
    coveredDays: number;
    missingDays: number;
    invalidDays: number;
    day0Unresolved: number;
  };
  warnings: string[];
  cohort: CohortGroup[];
  cohortByPattern: CohortGroup[];
  cohortByPointsBand: CohortGroup[];
}

/** GET /api/forward/rejections */
export interface ForwardRejection {
  id: string;
  batchId: string;
  slotTime: Iso | null;
  cmcId: number | null;
  symbol: string | null;
  starCount: number;
  reasons: string[];
  observed: unknown;
  createdAt: Iso;
}

/** POST /api/forward/update: started in the background, or why not. */
export interface ForwardUpdateResult {
  ok: boolean;
  reason?: string;
  updateRunId?: string;
}

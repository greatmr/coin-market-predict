// Shapes of the shared /api payloads (JSON: dates are ISO strings, exact decimals are strings).
// Section-specific payloads are typed next to their feature in features/<section>/types.ts.

/** A number the API sends as a decimal string (exact arithmetic on the server), or a plain number. */
export type Num = string | number;
export type Iso = string;

export type Role = 'owner' | 'analyzer' | 'reviewer';
export type Permission =
  | 'data:read'
  | 'health:read'
  | 'exports:read'
  | 'review:write'
  | 'scan:operate'
  | 'telegram:manage'
  | 'users:manage'
  | 'pipeline:recover'
  | 'agent:use';

export interface User {
  id: string;
  username: string;
  role: Role;
  permissions: Permission[];
  mustChangePassword: boolean;
  isActive: boolean;
  passwordChangedAt: Iso | null;
  lockedUntil: Iso | null;
  lastLoginAt: Iso | null;
  createdAt: Iso;
}

export interface ReviewVocabulary {
  venueDecisions: string[];
  eventDays: string[];
  judgments: string[];
  candleStates: string[];
  marketRegimes: string[];
  finalDecisions: string[];
}

/** GET /api/config */
export interface AppConfig {
  timezone: string;
  dataSource: string;
  isLiveData: boolean;
  providerName: string;
  attribution: string | null;
  telegramMode: string;
  schedulerEnabled: boolean;
  pipelineCron: string;
  nextRunAt: Iso | null;
  strategy: {
    name: string;
    rulesetVersion: string;
    rules: { passMultiple?: Num; [rule: string]: unknown };
    ranking: { version: string; [key: string]: unknown };
    crawlIntervalMinutes: number;
    maxQuoteAgeMinutes: number;
    dailyLookbackDays: number;
    venueRefreshHours: number;
    lbank: { refreshDays: number; maxAgeDays: number; requireManualVerification: boolean };
    overrides: { version: string; count: number } | { error: string };
  };
  review: ReviewVocabulary;
  retention: { snapshotDays: number; detailDays: number; exportDays: number };
}

export type RunStatus =
  'running' | 'succeeded' | 'partial' | 'failed' | 'skipped' | 'missed' | 'interrupted';

export interface PipelineStage {
  stage: string;
  status: string;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface RunProgress {
  percent: number;
  stagesDone: number;
  stagesTotal: number;
  current: { done: number; total: number; unit: string; etaSeconds?: number | null } | null;
}

export interface PipelineRun {
  id: string;
  kind: string;
  slotTime: Iso;
  status: RunStatus;
  currentStage: string | null;
  currentStageLabel: string | null;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  stages: PipelineStage[];
  metrics: ({ degraded?: string[]; [key: string]: unknown } & Record<string, unknown>) | null;
  error: string | null;
  progress: RunProgress | null;
}

export interface CrawlBatch {
  id: string;
  slotTime: Iso;
  status: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' | string;
  collected: number;
  listedTotal: number;
  crawledAt: Iso;
  [key: string]: unknown;
}

export interface ScanCounts {
  assets?: number;
  evaluated?: number;
  eligible?: number;
  needsReview?: number;
  excluded?: number;
  queue?: number;
  [key: string]: number | undefined;
}

export interface ScanSummary {
  batchId: string;
  asOf: Iso;
  finishedAt: Iso | null;
  queueStatus: string;
  counts: ScanCounts;
  warnings: unknown;
  rulesetVersion: string;
  configVersion: string;
  overridesVersion: string;
}

export interface SourceHealth {
  state: 'closed' | 'open' | 'suspended' | string;
  consecutiveFailures: number;
  openedAt: Iso | null;
  reopensAt: Iso | null;
  retryAfterUntil: Iso | null;
  suspendedReason: string | null;
}

/** GET /api/overview */
export interface Overview {
  provider: { id: string; name: string; isLive: boolean; attribution: string | null } | null;
  isLiveData: boolean;
  latestRun: PipelineRun | null;
  schedule: { enabled: boolean; cron: string; nextRunAt: Iso | null };
  latestBatch: CrawlBatch | null;
  scan: ScanSummary | null;
  latestScanStatus: { batchId: string; status: string; error: string | null } | null;
  export: { batchId: string; exportedAt: Iso; files: unknown } | null;
  crawlAgeMinutes: number | null;
  maxQuoteAgeMinutes: number;
  sourceHealth: SourceHealth | null;
  banners: string[];
  openMappingTasks: number;
}

/** GET /api/lbank (shape used by the overview's data-quality panel). */
export interface LbankStatus {
  list?: {
    status?: string;
    fetchedAt?: Iso | null;
    ageDays?: number | null;
    pairs?: number;
    [key: string]: unknown;
  } | null;
  maxAgeDays?: number;
  [key: string]: unknown;
}

/** POST results of the operate buttons (rescan, LBank refresh, crawl retry). */
export interface OperateResult {
  ok: boolean;
  reason?: string;
  status?: string;
  notes?: string[];
  counts?: { queue?: number; [key: string]: number | undefined };
  pairs?: number;
  slot?: Iso;
  circuitReset?: boolean;
}

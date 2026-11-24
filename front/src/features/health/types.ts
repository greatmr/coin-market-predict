// Payloads of /api/batches, /api/health, and /api/mapping-tasks (read-model service).
import type { Iso, PipelineStage, ScanCounts } from '../../types/api';

export interface BatchScan {
  status: string;
  queueStatus: string | null;
  counts: ScanCounts | null;
  warnings: string[];
  attempts: number;
  finishedAt: Iso | null;
  exportStatus: string | null;
  exportedAt: Iso | null;
  error: string | null;
}

/** GET /api/batches: crawl batches, newest first, with their scan run. */
export interface BatchRow {
  id: string;
  slotTime: Iso;
  isLive: boolean;
  startedAt: Iso;
  finishedAt: Iso;
  crawledAt: Iso;
  status: string;
  statusReasons: string[];
  listedTotal: number | null;
  collected: number;
  missingRanks: number[];
  duplicateRanks: number[];
  notes: string[];
  scan: BatchScan | null;
}

export interface ProviderRow {
  id: string;
  name: string;
  isLive: boolean;
  attribution: string | null;
}

export interface SourceHealthRow {
  state: string;
  consecutiveFailures: number;
  openedAt: Iso | null;
  lastSuccessAt: Iso | null;
  lastFailureAt: Iso | null;
  budgetPeriodStart: Iso | null;
  budgetUsed: number;
  suspendedReason: string | null;
}

export interface DiscoveryRunRow {
  id: string;
  startedAt: Iso;
  finishedAt: Iso | null;
  status: string;
}

export interface Coverage {
  provider: ProviderRow | null;
  isLiveData: boolean;
  knownAssets: number;
  lastDiscovery: DiscoveryRunRow | null;
  lastBatch: BatchRow | null;
  sourceHealth: SourceHealthRow | null;
  monthlyRequestBudget: number | null;
}

/** metrics.recovery of a run an owner recovered (PipelineService.recoverRun). */
export interface RunRecovery {
  action: 'crawl_current' | 'reprocess_batch' | 'catch_up_current' | 'catch_up_daily';
  requestedBy: string;
  requestedAt: Iso;
  status: 'running' | 'done' | 'failed';
  finishedAt?: Iso;
  batchId?: string | null;
  runId?: string | null;
  summary?: string;
  error?: string;
}

export interface RunRow {
  id: string;
  kind: string;
  slotTime: Iso;
  status: string;
  error: string | null;
  stages: PipelineStage[];
  metrics?: { recovery?: RunRecovery } | null;
}

/** POST /api/pipeline/runs/:id/recover */
export interface RecoverResult {
  ok: boolean;
  slot: Iso | null;
  reason?: string;
  action?: RunRecovery['action'];
  batchId?: string | null;
}

/** GET /api/health */
export interface HealthPayload {
  coverage: Coverage;
  runs: RunRow[];
}

/** GET /api/mapping-tasks?status=OPEN */
export interface MappingTask {
  id: string;
  cmcId: number;
  exchange: string;
  marketPair: string;
  kind: string;
  evidence: Record<string, unknown>;
  status: string;
  createdAt: Iso;
}

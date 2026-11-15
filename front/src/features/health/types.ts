// Payloads of /api/batches, /api/health, /api/mapping-tasks and /api/exports (read-model service).
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

export interface RunRow {
  id: string;
  kind: string;
  slotTime: Iso;
  status: string;
  error: string | null;
  stages: PipelineStage[];
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

export interface ExportFile {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
}

/** GET /api/exports */
export interface ExportRow {
  batchId: string;
  asOf: Iso;
  isLive: boolean;
  queueStatus: string | null;
  exportStatus: string | null;
  exportPath: string | null;
  exportFiles: ExportFile[] | null;
  exportedAt: Iso | null;
  error: string | null;
  available: boolean;
}

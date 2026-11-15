// Overview-only payload shapes (see backend scan.service.ts countsAndWarnings, venues.service.ts
// LbankListStatus and read-model scanSheet).
import type { Num } from '../../types/api';

export type Tally = Record<string, number>;

/** scan_run.counts as the scan writes it (everything the overview charts read). */
export interface ScanCountsDetail {
  assets?: number;
  evaluated?: number;
  eligible?: number;
  needsReview?: number;
  excluded?: number;
  queue?: number;
  stars?: Tally;
  pass?: Partial<Record<'pass3d' | 'pass7d' | 'pass30d', Tally>>;
  current?: Tally;
  lbank?: Tally;
  reasons?: Tally;
}

/** GET /api/lbank `list` (null until a complete list exists). */
export interface LbankList {
  fetchedAt: string;
  pairs: number;
  nextRefreshAt: string;
  stale: boolean;
  lastAttempt: { at: string; status: string; error: string | null } | null;
}

/** The fields of a Review Queue row the queue strip shows (GET /api/scan?sheet=queue). */
export interface QueueRow {
  cmcId: number;
  symbol: string;
  name: string;
  stars: number;
  currentVmc: Num | null;
  capUsd: Num | null;
  queueOrder: number | null;
  pass3d: string | null;
  pass7d: string | null;
  pass30d: string | null;
  multiple3d: Num | null;
  multiple7d: Num | null;
  multiple30d: Num | null;
  review: { finalDecision: string } | null;
}

export interface QueueSheet {
  batchId: string;
  rows: QueueRow[];
}

/** One stacked-bar segment. */
export interface StackSeg {
  value: number;
  tone: string;
  label: string;
}

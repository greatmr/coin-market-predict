// GET /api/scan?sheet=… (ReadModelService.scanSheet) and GET /api/assets?search=… (listAssets).
import type { Iso, Num } from '../../types/api';

export type PassStatus = 'YES' | 'NO' | 'N/A';

export interface LbankPair {
  marketPair: string;
  [key: string]: unknown;
}

/** The latest human review of a coin, attached to each sheet row. */
export interface RowReview {
  id: string;
  cmcId: number;
  batchId: string;
  revision: number;
  reviewer: string;
  reviewedAt: Iso;
  venueDecision: string;
  eventDay: string;
  finalDecision: string;
  planStatus: string | null;
}

/** One Tier 1 result row (the list columns of scan_result). */
export interface SheetRow {
  batchId: string;
  cmcId: number;
  symbol: string;
  name: string;
  slug: string | null;
  rank: number | null;
  ageDays: number | null;
  priceUsd: Num | null;
  capUsd: Num | null;
  volume24hUsd: Num | null;
  observedAt: Iso | null;
  crawledAt: Iso | null;
  currentStatus: string;
  currentReason: string | null;
  currentVmc: Num | null;
  vmc3dAvg: Num | null;
  vmc7dAvg: Num | null;
  vmc14dAvg: Num | null;
  vmc30dAvg: Num | null;
  avg3dReason: string | null;
  avg7dReason: string | null;
  avg14dReason: string | null;
  avg30dReason: string | null;
  multiple3d: Num | null;
  multiple7d: Num | null;
  multiple30d: Num | null;
  pass3d: PassStatus | null;
  pass7d: PassStatus | null;
  pass30d: PassStatus | null;
  reason3d: string | null;
  reason7d: string | null;
  reason30d: string | null;
  stars: number;
  eligibilityStatus: string;
  eligibilityReasons: string[] | null;
  assetClass: string | null;
  classSource: string | null;
  lbankStatus: string;
  lbankReason: string | null;
  lbankPairs: LbankPair[] | null;
  venueReview: unknown;
  venueFlags: string[] | null;
  flags: unknown;
  inQueue: boolean;
  queueOrder: number | null;
  weightedPassPoints: number | null;
  scoreComplete: boolean | null;
  weightedStrength: Num | null;
  rankingRulesetVersion: string | null;
  review: RowReview | null;
}

export interface SheetPage {
  batchId: string | null;
  asOf?: Iso | null;
  queueStatus?: string | null;
  isLive?: boolean | null;
  total: number;
  offset?: number;
  rows: SheetRow[];
}

/** A row of cmc_asset as the search returns it (only the fields the palette shows are relied on). */
export interface AssetHit {
  cmcId: number;
  symbol: string;
  name: string;
  [key: string]: unknown;
}

export interface AssetSearch {
  total: number;
  offset: number;
  assets: AssetHit[];
}

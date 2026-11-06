import { D, type DValue } from "../common/decimal.js";
import { type EligibilityStatus, type LbankStatus, REASON, RULES } from "./constants.js";

/**
 * Universe and eligibility (PDF p.3, p.9, p.10). Pure functions; boundaries are inclusive.
 * Status: EXCLUDED on any known failed hard filter, else NEEDS_REVIEW on any missing or
 * ambiguous input, else ELIGIBLE. All reasons are kept.
 */

/** CMC tags of tokens that represent an off-chain asset (assumption A5). */
export const TOKENIZED_TAGS: ReadonlySet<string> = new Set([
  "tokenized-stock",
  "tokenized-etfs",
  "tokenized-commodities",
  "tokenized-gold",
  "tokenized-silver",
  "tokenized-treasury-bonds",
  "tokenized-treasury-bills",
  "tokenized-real-estate",
]);

export const isStablecoinTag = (t: string) => t === "stablecoin" || t.endsWith("-stablecoin");

export type Tier1Class = "regular" | "stablecoin" | "tokenized" | "ambiguous";

export interface ClassOverride {
  class: "eligible" | "stablecoin" | "tokenized";
  reason: string;
  version: string;
}

export interface ClassInput {
  /** Raw CMC tags of this observation. */
  tags: readonly string[];
  /** Name / symbol / price-evidence class from ingestion (`classify.ts`), when it came from a heuristic. */
  heuristicClass: string | null;
  heuristicSource: string | null;
  override: ClassOverride | null;
}

export interface ClassResult {
  assetClass: Tier1Class;
  /** For ambiguous: wrapped | bridged | staked | stablecoin | tokenized (what the evidence suggests). */
  kind: string | null;
  source: string;
  evidence: string[];
}

/**
 * Classification from CMC tags plus the versioned override list (p.9). Only CMC tags exclude;
 * wrapped/bridged representations and heuristic-only matches are ambiguous → review (A5, A6).
 * Fan tokens are not excluded as a class.
 */
export function classify(i: ClassInput): ClassResult {
  const tags = i.tags.map((t) => t.toLowerCase());
  const evidence: string[] = [];
  if (tags.includes("fan-token")) evidence.push("fan-token (eligible as a class)");
  if (i.override) {
    const cls = i.override.class === "eligible" ? "regular" : i.override.class;
    return { assetClass: cls, kind: null, source: `override@${i.override.version}`, evidence: [...evidence, i.override.reason] };
  }
  const stable = tags.find(isStablecoinTag);
  if (stable) return { assetClass: "stablecoin", kind: null, source: `cmc_tag:${stable}`, evidence };
  const tokenized = tags.find((t) => TOKENIZED_TAGS.has(t));
  if (tokenized) return { assetClass: "tokenized", kind: null, source: `cmc_tag:${tokenized}`, evidence };
  const wrapped = tags.find((t) => t.includes("wrapped"));
  if (wrapped) return { assetClass: "ambiguous", kind: "wrapped", source: `cmc_tag:${wrapped}`, evidence };
  const bridged = tags.find((t) => t.includes("bridged"));
  if (bridged) return { assetClass: "ambiguous", kind: "bridged", source: `cmc_tag:${bridged}`, evidence };
  if (i.heuristicClass && i.heuristicClass !== "regular" && i.heuristicClass !== "unknown" && i.heuristicSource?.startsWith("heuristic")) {
    return { assetClass: "ambiguous", kind: i.heuristicClass, source: i.heuristicSource, evidence };
  }
  return { assetClass: "regular", kind: null, source: "cmc_tags", evidence };
}

export interface EligibilityInput {
  rank: number | null;
  /** The rank appears more than once in the batch. */
  rankDuplicate: boolean;
  capUsd: DValue | null;
  capProviderReported: boolean;
  dateAdded: Date | null;
  /** Rules' scan time = the batch's crawl time (A1). */
  asOf: Date;
  cls: ClassResult;
  lbank: { status: LbankStatus; reason: string | null };
}

export interface EligibilityResult {
  status: EligibilityStatus;
  reasons: string[];
  ageMs: number | null;
  ageDays: DValue | null;
  /** True when only rank/cap failed (used by the storage policy). */
  excludedByRankOrCapOnly: boolean;
}

const MIN_CAP = new D(RULES.minMarketCapUsd);

export function evaluateEligibility(i: EligibilityInput): EligibilityResult {
  const excluded: string[] = [];
  const review: string[] = [];

  if (i.rank === null) review.push(REASON.rankMissing);
  else if (i.rankDuplicate) review.push(REASON.rankAmbiguous);
  else if (i.rank < RULES.rankMin || i.rank > RULES.rankMax) excluded.push(REASON.rankOutOfRange);

  if (i.capUsd === null || !i.capProviderReported || !i.capUsd.isFinite() || i.capUsd.lte(0)) review.push(REASON.capMissing);
  else if (i.capUsd.lt(MIN_CAP)) excluded.push(REASON.capBelowMin);

  let ageMs: number | null = null;
  if (!i.dateAdded) review.push(REASON.dateAddedMissing);
  else {
    ageMs = i.asOf.getTime() - i.dateAdded.getTime();
    if (ageMs < 0) review.push(REASON.dateAddedFuture);
    else if (ageMs < RULES.minListingAgeMs) excluded.push(REASON.ageBelowMin);
  }

  if (i.cls.assetClass === "stablecoin") excluded.push(REASON.stablecoin);
  else if (i.cls.assetClass === "tokenized") excluded.push(REASON.tokenized);
  else if (i.cls.assetClass === "ambiguous") review.push(`${REASON.classAmbiguous}:${i.cls.kind ?? "unknown"}`);

  switch (i.lbank.status) {
    case "VERIFIED":
      break;
    case "PAIR_LISTED_UNVERIFIED":
      review.push(REASON.lbankUnverified);
      break;
    case "NOT_LISTED":
      excluded.push(REASON.noLbankPair);
      break;
    case "NOT_TRADABLE":
      excluded.push(REASON.lbankNotTradable);
      break;
    case "UNKNOWN":
      review.push(`${REASON.lbankUnknown}:${i.lbank.reason ?? "unknown"}`);
      break;
  }

  const status: EligibilityStatus = excluded.length ? "EXCLUDED" : review.length ? "NEEDS_REVIEW" : "ELIGIBLE";
  return {
    status,
    reasons: [...excluded, ...review],
    ageMs,
    ageDays: ageMs === null ? null : new D(ageMs).div(86_400_000),
    excludedByRankOrCapOnly: excluded.length > 0 && excluded.every((r) => r === REASON.rankOutOfRange || r === REASON.capBelowMin),
  };
}

/**
 * Whether completed daily rows should be fetched for an asset: everything not already excluded
 * by a known hard filter (A11). LBank NOT_LISTED / NOT_TRADABLE assets are excluded and skipped.
 */
export const needsDailyRows = (e: Pick<EligibilityResult, "status">) => e.status !== "EXCLUDED";

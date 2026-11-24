import { isoDate } from '../../common/utils/dates.js';
import type { DValue } from '../../common/utils/decimal.js';

/**
 * The CMC star-event rule shared by both trackers (docs/lbank-spot-observation.md § 2,
 * docs/forward-test.md § 3–4): which published Review Queue rows open an event, the event key, and
 * which tracker owns an event. Pure, no I/O.
 *
 * - An event is the first priced 1/2/3-star sighting per (provider, CMC id, UTC date of detection,
 *   star count); a later sighting of the same key is ignored (first insert wins). Same stars on the
 *   same UTC date → no new event; another star count → a new event; a later UTC date → a new event.
 * - Before the persisted cutover an event belongs to the legacy Star Event Forward Test
 *   (`forward_event`); at or after it, to the LBank Spot Price Observation (`lbank_obs_event`).
 *   The cutover is a UTC midnight, so no event key (which contains the UTC date) can straddle the two
 *   trackers, and a sighting is routed by its detection time alone.
 */

/** One published Review Queue row as the trigger sees it (adapter: docs/forward-test.md § 3). */
export interface TriggerCandidate {
  cmcId: number | null;
  stars: number;
  inQueue: boolean;
  eligibilityStatus: string;
  lbankStatus: string;
  /** CMC USD price of the qualifying observation, as stored by the scanner. */
  price: DValue | null;
  currentStatus: string;
  /** Provider update time of the quote. */
  sourceUpdatedAt: Date | null;
  /** Crawl time of the observation (becomes detected_at). */
  observedAt: Date | null;
  /** Exactly one stored CMC identity and one observation of this id in the batch. */
  identityUnique: boolean;
}

export interface TriggerContext {
  queueStatus: string | null;
  batchStatus: string;
  now: Date;
  /** A batch older than this when the trigger runs is a replay, not a live publication. */
  maxBatchAgeMs: number;
  maxQuoteAgeMs: number;
}

/** Reason codes of a queue row that opens no event (stable strings: database, exports, API, tests). */
export const TRIGGER_REASON = {
  queueNotPublished: 'QUEUE_NOT_PUBLISHED',
  batchNotComplete: 'BATCH_NOT_COMPLETE',
  batchNotCurrent: 'TRIGGER_BATCH_NOT_CURRENT',
  notInQueue: 'NOT_IN_REVIEW_QUEUE',
  notEligible: 'NOT_ELIGIBLE',
  starsOutOfRange: 'STARS_OUT_OF_RANGE',
  lbankNotVerified: 'LBANK_NOT_VERIFIED',
  cmcIdMissing: 'CMC_ID_MISSING',
  assetIdAmbiguous: 'ASSET_ID_AMBIGUOUS',
  priceMissing: 'PRICE_MISSING',
  priceNotFinite: 'PRICE_NOT_FINITE',
  priceNotPositive: 'PRICE_NOT_POSITIVE',
  quoteNotOk: 'QUOTE_NOT_OK',
  quoteStale: 'QUOTE_STALE',
  sourceTimeMissing: 'SOURCE_TIME_MISSING',
  observedAtMissing: 'OBSERVED_AT_MISSING',
} as const;

const R = TRIGGER_REASON;

/**
 * Reasons why a queue row must not open a priced event; empty when it may. Stars are taken from
 * the scanner as published, never recalculated. Every failing check is reported.
 */
export function validateTrigger(c: TriggerCandidate, ctx: TriggerContext): string[] {
  const reasons: string[] = [];
  if (ctx.queueStatus !== 'PUBLISHED')
    reasons.push(`${R.queueNotPublished}:${ctx.queueStatus ?? 'NONE'}`);
  if (ctx.batchStatus !== 'COMPLETE') reasons.push(`${R.batchNotComplete}:${ctx.batchStatus}`);
  if (!c.inQueue) reasons.push(R.notInQueue);
  if (c.eligibilityStatus !== 'ELIGIBLE') reasons.push(`${R.notEligible}:${c.eligibilityStatus}`);
  if (!Number.isInteger(c.stars) || c.stars < 1 || c.stars > 3)
    reasons.push(`${R.starsOutOfRange}:${c.stars}`);
  if (c.lbankStatus !== 'VERIFIED') reasons.push(`${R.lbankNotVerified}:${c.lbankStatus}`);
  if (c.cmcId === null || !Number.isSafeInteger(c.cmcId) || c.cmcId <= 0)
    reasons.push(R.cmcIdMissing);
  else if (!c.identityUnique) reasons.push(R.assetIdAmbiguous);
  if (c.price === null) reasons.push(R.priceMissing);
  else if (!c.price.isFinite()) reasons.push(R.priceNotFinite);
  else if (c.price.lte(0)) reasons.push(R.priceNotPositive);
  const quoteAgeMs =
    c.observedAt && c.sourceUpdatedAt ? c.observedAt.getTime() - c.sourceUpdatedAt.getTime() : null;
  if (c.currentStatus === 'STALE' || (quoteAgeMs !== null && quoteAgeMs > ctx.maxQuoteAgeMs))
    reasons.push(R.quoteStale);
  else if (c.currentStatus !== 'OK') reasons.push(`${R.quoteNotOk}:${c.currentStatus}`);
  if (!c.sourceUpdatedAt) reasons.push(R.sourceTimeMissing);
  if (!c.observedAt) reasons.push(R.observedAtMissing);
  else if (ctx.now.getTime() - c.observedAt.getTime() > ctx.maxBatchAgeMs)
    reasons.push(R.batchNotCurrent);
  return reasons;
}

/** The event key's date part: the UTC calendar date of detection (never the display timezone). */
export const detectedUtcDate = (detectedAt: Date): string => isoDate(detectedAt);

// ── Routing between the two trackers ─────────────────────────────────────────────────────────

export const SIGNAL_WORKFLOWS = ['LEGACY_FORWARD', 'LBANK_OBSERVATION'] as const;
export type SignalWorkflow = (typeof SIGNAL_WORKFLOWS)[number];

const DAY_MS = 86_400_000;

/** True when `at` is exactly 00:00:00.000 UTC: the only instants a cutover may take. */
export const isUtcMidnight = (at: Date): boolean => at.getTime() % DAY_MS === 0;

/**
 * Which tracker owns a sighting detected at `detectedAt`. Without a cutover every event stays with
 * the legacy forward test (the behaviour before this change). With one, detection at or after it
 * belongs to the LBank observation: a total rule, so a sighting can never go to neither or both.
 */
export function workflowFor(cutoverAt: Date | null, detectedAt: Date): SignalWorkflow {
  return cutoverAt !== null && detectedAt.getTime() >= cutoverAt.getTime()
    ? 'LBANK_OBSERVATION'
    : 'LEGACY_FORWARD';
}

/**
 * Why a cutover time cannot be set now (null when it can). It must be a UTC midnight (so no event
 * key straddles the trackers), strictly later than `minLeadMs` from now and than every crawl batch
 * already stored (so no sighting already routed can change tracker), and an existing cutover can be
 * moved only while it is itself still that far in the future.
 */
export function cutoverProblem(input: {
  requested: Date;
  current: Date | null;
  now: Date;
  latestBatchCrawledAt: Date | null;
  minLeadMs: number;
}): string | null {
  const { requested, current, now, latestBatchCrawledAt, minLeadMs } = input;
  if (Number.isNaN(requested.getTime())) return 'not a valid time';
  if (!isUtcMidnight(requested)) return 'the cutover must be exactly 00:00:00.000 UTC';
  if (requested.getTime() < now.getTime() + minLeadMs)
    return `the cutover must be at least ${Math.round(minLeadMs / 60_000)} minutes in the future`;
  if (latestBatchCrawledAt && requested.getTime() <= latestBatchCrawledAt.getTime())
    return 'a crawl batch at or after this time is already stored';
  if (current && current.getTime() < now.getTime() + minLeadMs)
    return `the cutover ${current.toISOString()} has passed or is about to: it can no longer change`;
  return null;
}

import type { TimingSource } from './observation.constants.js';

/**
 * The observation start (docs/lbank-spot-observation.md § 2a, rules v2): the earliest server-recorded
 * instant at which the star signal was proven published and usable, never the crawl start.
 *
 * Traced on production (13 hourly batches, 2026-11-25): the crawl starts at t0 (hh:07:00.05); the scan
 * writes the batch's Review Queue rows and `scan_run.status = succeeded` in one transaction, and
 * `/api/scan` (the dashboard's Review Queue) reads the newest succeeded scan, so the row is served the
 * moment that transaction commits (3.1 s – 8 min 32 s after t0). The pipeline records
 * `pipeline_stage(scan).finished_at` right after the commit (≈ 4 ms after the in-transaction
 * `scan_run.finished_at`), which makes it the earliest PROVEN usable time. The event row itself is
 * committed later by the observe stage (5.4 s – 10 min 47 s after t0).
 */
export interface TimingRecords {
  /** t0: the batch's crawl time (event identity, UTC date, cutover routing — never changed). */
  crawlAt: Date;
  /** The CMC quote time behind the signal (provider update; provenance only). */
  cmcQuoteAt: Date | null;
  /** The pipeline run that published the queue and ran the intake (null: not from a pipeline run). */
  pipelineRunId: string | null;
  /** Its scan stage row (written after the scan transaction committed). */
  scanStage: {
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    attempts: number;
  } | null;
  /** `scan_run` of the batch: `finished_at` is written inside the publishing transaction. */
  scanRun: { finishedAt: Date | null; attempts: number; queueStatus: string | null } | null;
  /** The intake's start (it read the published queue then). */
  intakeAt: Date | null;
  /**
   * A time after the event's own transaction committed: measured right after the commit (live
   * intake) or the observe stage's `finished_at` (recorded after the intake committed).
   */
  eventCommittedAt: Date | null;
  /** The observation job's run time when it first read the observation without a start. */
  jobSeenAt: Date | null;
}

export interface ActionableTiming {
  at: Date;
  source: TimingSource;
  /** Not the scan commit: the start is later than the earliest moment the signal was usable. */
  uncertain: boolean;
  evidence: Record<string, unknown>;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The proven actionable time and its provenance; null when no record proves any time yet. */
export function actionableTiming(r: TimingRecords): ActionableTiming | null {
  const crawlMs = r.crawlAt.getTime();
  const stage = r.scanStage;
  const stageOk =
    stage?.status === 'succeeded' &&
    !!stage.finishedAt &&
    stage.finishedAt.getTime() >= crawlMs &&
    // The intake read the queue after the scan had committed (sequential stages of one run).
    (!r.intakeAt || stage.finishedAt.getTime() <= r.intakeAt.getTime());
  const evidence: Record<string, unknown> = {
    crawlAt: iso(r.crawlAt),
    cmcQuoteAt: iso(r.cmcQuoteAt),
    pipelineRunId: r.pipelineRunId,
    scanStage: stage
      ? {
          status: stage.status,
          startedAt: iso(stage.startedAt),
          finishedAt: iso(stage.finishedAt),
          attempts: stage.attempts,
        }
      : null,
    scanRun: r.scanRun
      ? {
          finishedAtInTransaction: iso(r.scanRun.finishedAt),
          attempts: r.scanRun.attempts,
          queueStatus: r.scanRun.queueStatus,
        }
      : null,
    intakeAt: iso(r.intakeAt),
    eventCommittedAt: iso(r.eventCommittedAt),
    jobSeenAt: iso(r.jobSeenAt),
  };
  const pick = (at: Date, source: ActionableTiming['source']): ActionableTiming => {
    const lower = r.scanRun?.finishedAt ?? r.crawlAt;
    return {
      at,
      source,
      uncertain: source !== 'SCAN_COMMIT',
      evidence: {
        ...evidence,
        rule:
          source === 'SCAN_COMMIT'
            ? 'the scan stage finished: the Review Queue holding this row was committed and served by /api/scan before this instant'
            : source === 'EVENT_COMMIT'
              ? 'no scan record: the event was committed and served on the LBank Spot page before this instant'
              : 'no scan or event record: the first observation run that read the event',
        // The usable moment lies in [lowerBound, at]; for the scan commit only milliseconds wide.
        lowerBound: iso(lower),
        uncertaintyMs: at.getTime() - lower.getTime(),
        afterCrawlMs: at.getTime() - crawlMs,
      },
    };
  };
  if (stageOk) return pick(stage.finishedAt!, 'SCAN_COMMIT');
  if (r.eventCommittedAt && r.eventCommittedAt.getTime() >= crawlMs)
    return pick(r.eventCommittedAt, 'EVENT_COMMIT');
  if (r.jobSeenAt && r.jobSeenAt.getTime() >= crawlMs) return pick(r.jobSeenAt, 'JOB_FIRST_SEEN');
  return null;
}

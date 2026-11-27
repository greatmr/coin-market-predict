import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, In, IsNull } from 'typeorm';

import type { DValue } from '../../common/utils/decimal.js';

import { CutoverService } from '../star-events/cutover.service.js';
import {
  PublishedQueueService,
  type TriggerBatch,
  type TriggerRow,
} from '../star-events/published-queue.service.js';
import { detectedUtcDate, validateTrigger, workflowFor } from '../star-events/star-event.rules.js';
import { type QueueStatus, StrategyService } from '../strategy/index.js';

import { CandleStoreService } from './candle-store.service.js';
import { ObsEvent } from './entities/obs-event.entity.js';
import { type IntakeDetails, ObsIntakeRun } from './entities/obs-intake-run.entity.js';
import { Observation } from './entities/observation.entity.js';
import { resolveSpotPair } from './observation-rules.js';
import {
  type ActionableTiming,
  type TimingRecords,
  actionableTiming,
} from './observation-timing.js';
import { newObservationValues, timingValues } from './observation-values.js';

export interface IntakeReport {
  batchId: string;
  intakeRunId: string;
  queueStatus: QueueStatus | null;
  queueRows: number;
  created: IntakeDetails['created'];
  ignored: IntakeDetails['ignored'];
  rejected: IntakeDetails['rejected'];
}

export interface IntakeSkipped {
  batchId: string;
  skipped: string;
}

const text = (v: DValue | null) => (v === null ? null : v.toFixed());

/**
 * Intake of the LBank Spot Price Observation (docs/lbank-spot-observation.md § 2): reads a batch's
 * published Review Queue and, for batches detected at or after the cutover, opens one event per
 * (CMC id, UTC date, star count) with the shared star-event rule — first insert wins — and its
 * observation in the same transaction. Rows that cannot open an event are recorded with reasons.
 * Rerunning a batch creates nothing new.
 *
 * The event key, its UTC date and the routing use the crawl time (t0) exactly as before; the
 * observation's start is the moment the queue row was proven usable (§ 2a): the pipeline's scan
 * stage finish (SCAN_COMMIT), else a time measured right after this intake committed
 * (EVENT_COMMIT). Never the crawl time.
 */
@Injectable()
export class ObservationIntakeService {
  private readonly log = new Logger(ObservationIntakeService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly strategy: StrategyService,
    private readonly queue: PublishedQueueService,
    private readonly cutover: CutoverService,
    private readonly candles: CandleStoreService,
  ) {}

  async intakeBatch(
    batchId: string,
    opts: { now: Date; pipelineRunId?: string | null; clock?: () => Date },
  ): Promise<IntakeReport | IntakeSkipped> {
    // A batch whose observations were deleted (M021) is never reopened, whatever re-runs it.
    const [deleted] = (await this.db.query(
      `SELECT d.deletion_id::text AS deletion_id, c.deleted_at
         FROM lbank_obs_deleted_batch d JOIN lbank_obs_cohort_deletion c ON c.id = d.deletion_id
        WHERE d.batch_id = $1`,
      [batchId],
    )) as Array<{ deletion_id: string; deleted_at: Date }>;
    if (deleted)
      return {
        batchId,
        skipped: `its observations were deleted (cohort deletion ${deleted.deletion_id}, ${deleted.deleted_at.toISOString()}): never reopened`,
      };
    const q = await this.queue.queueRows(batchId);
    const detectedAt = q.batch.crawledAt ?? q.rows.find((r) => r.observedAt)?.observedAt ?? null;
    const cut = await this.cutover.get(q.batch.providerId);
    if (!detectedAt || workflowFor(cut, detectedAt) !== 'LBANK_OBSERVATION')
      return {
        batchId,
        skipped: cut
          ? `before the cutover ${cut.toISOString()}: the batch belongs to the legacy forward test`
          : 'no cutover set: the legacy forward test takes every event',
      };
    return this.intake(q.batch, q.queueStatus, q.rows, cut!, opts);
  }

  async intake(
    batch: TriggerBatch,
    queueStatus: QueueStatus | null,
    rows: readonly TriggerRow[],
    cutoverAt: Date,
    opts: {
      now: Date;
      pipelineRunId?: string | null;
      /** Clock read right after the intake commits (EVENT_COMMIT fallback); default: wall clock. */
      clock?: () => Date;
    },
  ): Promise<IntakeReport> {
    const maxAge = this.strategy.maxQuoteAgeMs;
    const scanRecords = await this.scanRecords(batch.id, opts.pipelineRunId ?? null);
    const ctx = {
      queueStatus,
      batchStatus: batch.status,
      now: opts.now,
      maxBatchAgeMs: maxAge,
      maxQuoteAgeMs: maxAge,
    };
    const report = await this.db.transaction(async (m) => {
      const runId = (
        (await m
          .createQueryBuilder()
          .insert()
          .into(ObsIntakeRun)
          .values({
            providerId: batch.providerId,
            batchId: batch.id,
            pipelineRunId: opts.pipelineRunId ?? null,
            intakeAt: opts.now,
            queueStatus,
            batchStatus: batch.status,
            queueRows: rows.length,
            created: 0,
            ignored: 0,
            rejected: 0,
            details: { created: [], ignored: [], rejected: [] },
            notes: [],
          })
          .returning('id')
          .updateEntity(false)
          .execute()) as { raw: Array<{ id: string }> }
      ).raw[0]!.id;
      const r: IntakeReport = {
        batchId: batch.id,
        intakeRunId: runId,
        queueStatus,
        queueRows: rows.length,
        created: [],
        ignored: [],
        rejected: [],
      };
      for (const row of rows) {
        const reasons = validateTrigger(row, ctx);
        // Defence in depth: each row's own detection time routes it (the batch's crawl time).
        if (row.observedAt && workflowFor(cutoverAt, row.observedAt) !== 'LBANK_OBSERVATION')
          reasons.push('BEFORE_CUTOVER');
        if (reasons.length) {
          r.rejected.push({
            cmcId: row.cmcId,
            symbol: row.symbol,
            stars: row.stars,
            reasons,
            observed: {
              price: text(row.price),
              sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
              observedAt: row.observedAt?.toISOString() ?? null,
              currentStatus: row.currentStatus,
              eligibilityStatus: row.eligibilityStatus,
              lbankStatus: row.lbankStatus,
              inQueue: row.inQueue,
              identityUnique: row.identityUnique,
            },
          });
          continue;
        }
        const id = await this.insertEvent(m, batch, runId, row, opts.now, scanRecords);
        if (id) {
          r.created.push({ eventId: id, cmcId: row.cmcId!, stars: row.stars });
          continue;
        }
        const existing = await m.getRepository(ObsEvent).findOne({
          where: {
            providerId: batch.providerId,
            cmcId: row.cmcId!,
            detectedUtcDate: detectedUtcDate(row.observedAt!),
            starCount: row.stars,
          },
          select: { id: true },
        });
        // No event with the key: a deleted cohort's key (M021) keeps it taken, as the original did.
        const deletedKey = existing
          ? false
          : (
              (await m.query(
                `SELECT 1 FROM lbank_obs_deleted_key WHERE provider_id = $1 AND cmc_id = $2
                    AND detected_utc_date = $3 AND star_count = $4`,
                [batch.providerId, row.cmcId!, detectedUtcDate(row.observedAt!), row.stars],
              )) as unknown[]
            ).length > 0;
        r.ignored.push({
          cmcId: row.cmcId!,
          stars: row.stars,
          eventId: existing?.id ?? null,
          ...(deletedKey ? { deletedKey: true } : {}),
        });
      }
      const notes =
        queueStatus === 'PUBLISHED' || !rows.length
          ? []
          : [`queue ${queueStatus ?? 'not scanned'}: no event opened from this batch`];
      await m.getRepository(ObsIntakeRun).update(
        { id: runId },
        {
          created: r.created.length,
          ignored: r.ignored.length,
          rejected: r.rejected.length,
          details: { created: r.created, ignored: r.ignored, rejected: r.rejected } as never,
          notes,
        },
      );
      return r;
    });
    // Without a scan record the start is this commit, read after it (never the crawl time).
    if (report.created.length) {
      const committedAt = (opts.clock ?? (() => new Date()))();
      const pending = await this.db.getRepository(Observation).find({
        where: { eventId: In(report.created.map((c) => c.eventId)), observationStart: IsNull() },
      });
      const cmcOf = new Map(report.created.map((c) => [c.eventId, c.cmcId]));
      for (const o of pending) {
        const row = rows.find((r) => r.cmcId === cmcOf.get(o.eventId));
        const timing = actionableTiming({
          ...scanRecords,
          crawlAt: o.t0,
          cmcQuoteAt: row?.sourceUpdatedAt ?? null,
          intakeAt: opts.now,
          eventCommittedAt: committedAt,
          jobSeenAt: null,
        });
        if (timing)
          await this.db.getRepository(Observation).update({ id: o.id }, timingValues(timing));
      }
    }
    this.log.log(
      `LBank observation intake ${batch.slotTime.toISOString()}: ${report.queueRows} queue rows → ${report.created.length} new events, ${report.ignored.length} already recorded, ${report.rejected.length} rejected`,
    );
    return report;
  }

  /** The server's records of the batch's publication: the run's scan stage and the scan run. */
  private async scanRecords(
    batchId: string,
    pipelineRunId: string | null,
  ): Promise<Pick<TimingRecords, 'pipelineRunId' | 'scanStage' | 'scanRun'>> {
    const [stage] = pipelineRunId
      ? ((await this.db.query(
          `SELECT status, started_at, finished_at, attempts FROM pipeline_stage WHERE run_id = $1 AND stage = 'scan'`,
          [pipelineRunId],
        )) as Array<{
          status: string;
          started_at: Date | null;
          finished_at: Date | null;
          attempts: number;
        }>)
      : [];
    const [scan] = (await this.db.query(
      `SELECT finished_at, attempts, queue_status FROM scan_run WHERE batch_id = $1`,
      [batchId],
    )) as Array<{ finished_at: Date | null; attempts: number; queue_status: string | null }>;
    return {
      pipelineRunId,
      scanStage: stage
        ? {
            status: stage.status,
            startedAt: stage.started_at,
            finishedAt: stage.finished_at,
            attempts: stage.attempts,
          }
        : null,
      scanRun: scan
        ? { finishedAt: scan.finished_at, attempts: scan.attempts, queueStatus: scan.queue_status }
        : null,
    };
  }

  /** The event (first insert wins) and its observation; null when the key already exists. */
  private async insertEvent(
    m: EntityManager,
    batch: TriggerBatch,
    intakeRunId: string,
    row: TriggerRow,
    now: Date,
    scan: Pick<TimingRecords, 'pipelineRunId' | 'scanStage' | 'scanRun'>,
  ): Promise<string | null> {
    const detectedAt = row.observedAt!;
    const inserted = (await m
      .createQueryBuilder()
      .insert()
      .into(ObsEvent)
      .values({
        providerId: batch.providerId,
        cmcId: row.cmcId!,
        detectedUtcDate: detectedUtcDate(detectedAt),
        starCount: row.stars,
        detectedAt,
        sourceUpdatedAt: row.sourceUpdatedAt!,
        sourceBatchId: batch.id,
        slotTime: batch.slotTime,
        snapshotId: row.snapshotId,
        intakeRunId,
        isLive: batch.isLive,
        cmcPriceUsd: text(row.price) as never,
        symbol: row.symbol,
        name: row.name,
        slug: row.slug,
        rank: row.rank,
        platformChain: row.platformChain,
        platformAddress: row.platformAddress,
        capUsd: text(row.capUsd) as never,
        volume24hUsd: text(row.volume24hUsd) as never,
        currentVmc: text(row.currentVmc) as never,
        vmc3dAvg: text(row.vmc3dAvg) as never,
        vmc7dAvg: text(row.vmc7dAvg) as never,
        vmc14dAvg: text(row.vmc14dAvg) as never,
        vmc30dAvg: text(row.vmc30dAvg) as never,
        multiple3d: text(row.multiple3d) as never,
        multiple7d: text(row.multiple7d) as never,
        multiple30d: text(row.multiple30d) as never,
        pass3d: row.pass3d,
        pass7d: row.pass7d,
        pass30d: row.pass30d,
        queueOrder: row.queueOrder,
        weightedPassPoints: row.weightedPassPoints,
        scoreComplete: row.scoreComplete,
        weightedStrength: text(row.weightedStrength) as never,
        rankingRulesetVersion: row.rankingRulesetVersion,
        lbankPairs: row.lbankPairs as never,
        rulesetVersion: row.rulesetVersion,
        configVersion: row.configVersion,
        inputsHash: row.inputsHash,
        scanSnapshot: row.scanSnapshot as never,
      })
      .orIgnore()
      .returning('id')
      .updateEntity(false)
      .execute()) as { raw: Array<{ id: string }> };
    const id = inserted.raw[0]?.id ?? null;
    if (!id) return null;
    const mapping = resolveSpotPair(row.lbankPairs);
    const pairId =
      mapping.status === 'OK'
        ? await this.candles.ensurePair(m, mapping.symbol!, mapping.base!, mapping.quote!)
        : null;
    // The scan commit is known now; otherwise the start is set right after this commit.
    const timing: ActionableTiming | null = actionableTiming({
      ...scan,
      crawlAt: detectedAt,
      cmcQuoteAt: row.sourceUpdatedAt,
      intakeAt: now,
      eventCommittedAt: null,
      jobSeenAt: null,
    });
    await m
      .createQueryBuilder()
      .insert()
      .into(Observation)
      .values({
        ...newObservationValues(
          { id, isLive: batch.isLive, detectedAt },
          batch.providerId,
          pairId,
          mapping,
          now,
        ),
        ...(timing?.source === 'SCAN_COMMIT' ? timingValues(timing) : {}),
      })
      .orIgnore()
      .updateEntity(false)
      .execute();
    return id;
  }
}
